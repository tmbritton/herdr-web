# Herdr Web Terminal Bridge

A mobile-friendly browser bridge to persistent Herdr terminal panes, built around
Gleam on the BEAM, Mist, Effect, xterm.js, and private access through Tailscale Serve.

**Status:** Live streaming, pane navigation and explicit control. Open
`http://127.0.0.1:3000` to browse existing Herdr tabs and panes. Every attachment
starts in watch mode. Lifecycle recovery, touch keys, font sizing and a multiline
prompt composer are implemented. `/healthz` checks bridge liveness.
**Full history** opens a read-only OpenCode transcript with access to the session's
beginning, beyond the terminal application's retained view.

## Tooling and deployment choice

Use **mise for development** and a **systemd user service for deployment**.

- `mise.toml` pins Gleam, Erlang/OTP, Rebar3 and Node and provides project tasks.
- `gleam.toml` declares dependencies; `manifest.toml` locks their resolved versions
  and belongs in version control.
- `gleam export erlang-shipment` builds a production bundle of BEAM bytecode.
  The bundle needs Erlang at runtime, but not Gleam, Rebar3, or mise.
- systemd runs the installed bundle as your normal user, with automatic restart
  on failure and logs in the journal. This fits access to your existing Herdr
  server and its persistent panes.

Docker is unnecessary for the initial local bridge. It would add container
networking and Herdr socket/configuration mounts to a service that already needs
to work closely with the host user's Herdr session.

## Development

Install [mise](https://mise.jdx.dev/), then run from this directory:

```bash
mise trust
mise install
mise exec -- npm ci
mise run hooks:install
mise run dev
```

Open <http://127.0.0.1:3000>. Stop the foreground process with `Ctrl+C`.
The first run downloads and compiles the Hex dependencies. On systems where mise
builds Erlang from source, its host build prerequisites must also be installed;
see [mise's Erlang guide](https://mise.jdx.dev/lang/erlang.html).

```bash
mise run format   # Format source and tests
mise run check    # Formatting and type checks
mise run lint     # Gleam compiler warnings treated as errors
mise run build    # Compile development code
mise run test     # Gleam/HTTP tests and Effect-aware frontend unit tests
mise run export   # Production bundle in build/erlang-shipment/
```

Unit tests do not require Herdr. The optional `mise exec -- npm run test:integration`
exports the production shipment, creates and cleans up its own named Herdr
session, and runs real WebSocket and Chromium checks. It also restarts the bridge
while controlling a pane and verifies that the workload's state survives.
Install Chromium once with `mise exec -- npx playwright install
chromium`. Existing panes are not used by the test.

The pane picker refreshes every five seconds, groups by workspace/tab, and uses
row-major layout order. Selection follows pane identity through rearrangements;
when a pane closes, the next pane at its previous position (or the last remaining
pane) is selected. Use header buttons/swipes to navigate; terminal gestures stay
inside the terminal. Tap the pane title to open the picker. **Options** contains
font sizing, refresh/reconnect actions and manual pane IDs.
In watch mode, the terminal keeps the stream's dimensions and can be panned
horizontally. Browser input is disabled.
Frames are acknowledged only after xterm.js processes them; reconnecting creates
a fresh attachment.

### Control and recovery

Choose **Take control** before typing. If another controller is active, **Take
over** explicitly replaces it. **Release** returns to watch mode. **Fit terminal**
uses the available container and follows subsequent layout changes while
controlling; watch mode never sends resize commands. Leaving the pane or hiding
the page closes the attachment. Returning/reconnecting obtains a fresh view in
watch mode. Input is never automatically replayed.

Attachments have an 8-second initial-frame deadline, a 10-second rendered-frame
acknowledgement deadline and a 20-second client-idle deadline. The browser sends
heartbeats every five seconds. Server deadlines use monotonic time and are checked
once per second; TCP writes also have a two-second timeout. A live heartbeat does
not extend a stalled renderer's deadline. The browser independently times out a
silent bridge and reconnects in watch mode, including after page suspension.
Use **Reconnect** for an immediate fresh attachment.

Browser buffering is bounded, and the CLI transport has a 1 MiB cumulative input
budget per attachment because Herdr does not acknowledge stdin consumption.
Exhausting that budget releases control; take control again to continue. Actual
desktop-TUI handoff and Pixel Fold transitions still need hands-on validation.

### Phone workflow

- **Full history** opens the selected pane's OpenCode transcript in a new tab,
  available in watch mode. **Beginning** jumps to the first stored message;
  **Older**/**Newer** move through bounded pages and **Latest** refreshes the end.
  Text, reasoning and tool output are plain text; large entries continue across
  pages. The view reads the local OpenCode database without sending terminal input.
- **Top**, **Page up**, **Page down** and **Bottom** send Home, Page Up, Page Down
  and End to the controlled application. OpenCode 1.19.5 retains only 100 messages
  in its TUI, so use **Full history** for older content. Other applications and
  customized keybindings may interpret these keys differently.
- **Keyboard** focuses the live terminal input. The bottom toolbar provides
  `Esc`, `Tab`, arrows, `Ctrl`, `Ctrl+C` and `Enter`. Ctrl is a one-shot modifier
  for the next terminal key; input remains disabled in watch mode.
- **Write a prompt** opens a multiline editor for typing, pasting or dictation.
  **Paste** inserts text without Enter. **Paste + Enter** waits briefly after
  pasting and rechecks the attachment before sending Enter. The toolbar's
  **Enter** button also submits a non-empty prompt while the editor is focused;
  otherwise it sends Enter directly to the terminal.
- Select **Bracketed** for applications expecting bracketed paste (the default
  for the OpenCode/TUI workflow), or **Plain text** for applications that do not.
  Herdr 0.8.2's rendered stream does not expose the application's paste mode, so
  the choice is explicit. Clipboard pastes into the terminal follow this choice.
  All input stays on the owned controller stream.
- Successful submissions clear the editor and its saved draft, unless you edited
  it while sending. Paste-only actions, failed/cancelled submissions and newer
  edits keep their drafts. **Clear draft** discards a draft manually. Herdr does
  not acknowledge application input, so uncertain sends are never automatically
  retried. Drafts are page-local and per-terminal; a full page reload discards
  them. Pane selection and text size persist when storage permits.
- The layout follows the visual viewport when the keyboard opens. Folding,
  rotation and resizing preserve the selected pane, terminal instance and socket
  while the page remains active. Touch keys stay at the bottom of the visible UI.

Automated browser checks cover narrow, wide, short and tall viewports, touch keys,
multiline paste, reload, and per-terminal drafts. Physical Pixel 9 Fold keyboard,
dictation, folding/split-screen and lock/unlock checks remain a manual acceptance
pass, together with a real OpenCode prompt/response and desktop-TUI handoff.

Configuration is read at startup:

| Variable | Default / purpose |
| --- | --- |
| `HERDR_WEB_PORT` | `3000`, always bound to loopback |
| `HERDR_WEB_SESSION` | Unset: use the default Herdr session |
| `HERDR_WEB_ORIGINS` | Comma-separated exact origins; defaults to `http://127.0.0.1:3000,http://localhost:3000` |
| `HERDR_WEB_EXECUTABLE` | `herdr`; override the CLI executable path if necessary |
| `HERDR_WEB_SQLITE_EXECUTABLE` | `sqlite3`; SQLite CLI with JSON support for read-only history |
| `HERDR_WEB_OPENCODE_DB` | `$XDG_DATA_HOME/opencode/opencode.db`, or `$HOME/.local/share/opencode/opencode.db` |

For Tailscale Serve, include its exact HTTPS origin in `HERDR_WEB_ORIGINS` and
restart the bridge. WebSocket requests require both an allowed Origin and Host.
History requires a local OpenCode database and Herdr's reported OpenCode session
identity. Install SQLite 3.38+ (`sqlite3`) for this feature and the integration
tests. See [`docs/HISTORY.md`](docs/HISTORY.md) for the verified storage format and
pagination behavior.

### Quality checks and native dependencies

Gleam's standard formatter is `gleam format`; its compiler provides type and lint
diagnostics. `mise run check` checks formatting, runs `gleam check`, builds with
`--warnings-as-errors`, and compiles Erlang interoperability modules with
`erlc -Werror`. Browser code uses strict TypeScript, type-aware ESLint, Prettier,
and Effect's compiler diagnostics (`@effect/tsgo`). Runtime tests use
`@effect/vitest`, including virtual clocks, property tests and cancellation tests,
plus Node tests for deployment-process cleanup.
The installed pre-commit hook runs `check` and `test`; reinstall it
with `mise run hooks:install` after cloning or changing the hook.

The frontend is built on **Effect 4.1.4**: schemas and branded identifiers at data
boundaries, tagged protocol states and control capabilities, typed errors,
replaceable Context/Layer services, scoped sockets and event subscriptions, and
bounded queues. See [`docs/EFFECT_FRONTEND.md`](docs/EFFECT_FRONTEND.md) for the
design, source findings, and guarantees enforced by the tests and compiler.

The supervised subprocess adapter uses `erlexec`. Building its port executable
requires GNU Make and a C++17 compiler; deployed snapshots include that executable
and require the host's standard C++ runtime libraries.

Verify the Erlang crypto NIF with `mise exec -- erl -noshell -eval
'crypto:hash(sha, <<"test">>), halt().'`. A prebuilt OTP distribution can be
incompatible with Fedora/Bazzite's system OpenSSL. On the initial development
machine, `mise.local.toml` sets `LD_LIBRARY_PATH` to the locally installed Homebrew
OpenSSL `lib` directory (`brew --prefix openssl@3`). This machine-specific override
is ignored by Git; the service installer preserves it in the deployed runtime
environment. Use a host-compatible OTP build or library path on another machine.

## Background service

On Linux with systemd, make `herdr` and `sqlite3` available on your shell's `PATH`, then:

```bash
mise run service:install
mise run service:start
systemctl --user status herdr-web.service
curl --retry 10 --retry-connrefused --retry-delay 1 --fail http://127.0.0.1:3000/healthz
```

Stop any foreground development instance first; both use port 3000.

The installer builds and copies an independent production snapshot into
`~/.local/share/herdr-web/releases/`, points `current` at it, and installs
[`deploy/herdr-web.service`](deploy/herdr-web.service) into
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/`. It records the resolved Erlang and
Herdr and SQLite binary directories in the snapshot's `runtime.env`, so systemd does not
depend on interactive shell initialization. The installer itself does not start
or restart the service.

### Service configuration and private HTTPS

The unit also reads the optional `~/.config/herdr-web/environment` file. This
file is independent of installed snapshots. For example:

```ini
HERDR_WEB_SESSION=default
HERDR_WEB_ORIGINS=http://127.0.0.1:3000,http://localhost:3000,https://device.tailnet-name.ts.net:10000
```

Use the exact HTTPS origin shown for your device, including a non-default port.
Restart the service after changing this file. If changing `HERDR_WEB_PORT`, update
the allowed local origins and the Serve target as well.

Inspect existing Serve endpoints, then choose a free HTTPS port:

```bash
tailscale serve status
systemctl --user restart herdr-web.service
tailscale serve --bg --https=10000 http://127.0.0.1:3000
```

The phone opens `https://device.tailnet-name.ts.net:10000/` while connected to
Tailscale. Serve supplies TLS and tailnet access rules govern access. The initial
deployment uses port 10000 because ports 443 and 8443 already host other services.
Serve's background configuration persists across Tailscale restarts/reboots.

Verify the installed service (requires a reachable Herdr server):

```bash
mise exec -- npm run test:service -- http://127.0.0.1:3000
mise exec -- npm run test:service -- https://device.tailnet-name.ts.net:10000
```

This read-only smoke test checks health, schema-validated discovery, WebSocket
upgrade using a nonexistent pane, and rejection of an untrusted origin. To remove
this Serve endpoint later, use `tailscale serve --https=10000 off`.

`service:start` enables and starts the service. To start at boot and keep running
after logout, enable user lingering once:

```bash
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

Lingering is already enabled on the initial development machine. On another
machine this may require administrator authorization. Herdr's persistent server
and panes are managed separately; starting the bridge does not start an agent.

### Logs, updates, and stopping

```bash
mise run service:logs

# Install an updated snapshot, then switch the running service to it:
mise run service:install
systemctl --user restart herdr-web.service

# Stop for local development:
mise run service:stop

# Stop and disable automatic startup:
systemctl --user disable --now herdr-web.service
```

Development builds do not modify the installed snapshot. Reinstall after changing
tool versions or moving the Erlang/Herdr installations; keep the pinned Erlang
installation available while a deployed snapshot uses it. Previous snapshots are
retained in `releases/`; they can be removed after restarting onto the new snapshot
and confirming it works. Keep the snapshot referenced by `current`.

For private phone access, use Tailscale Serve as described in [PLAN.md](PLAN.md).

## Project layout

```text
src/herdr_web.gleam       Server startup, loopback binding, and process lifetime
src/herdr_web/web.gleam   HTTP routes, discovery, assets and WebSocket routing
src/herdr_web/socket.gleam Attachment/control protocol and worker lifecycle
frontend/                Effect application, schemas, services, xterm.js UI/tests
test/                    Gleeunit runner, protocol and process/HTTP tests
deploy/                  systemd user-service definition
scripts/                 Build, deployment, hooks and real browser integration
gleam.toml               Gleam package and dependencies
manifest.toml            Generated dependency lockfile
mise.toml                Pinned tools and development/deployment tasks
```

`frontend/` contains the browser UI and tests. esbuild produces `priv/static/`,
which is included in the production shipment. Development and export tasks build
these assets automatically; Node/npm are build-time tools only.

## Design

See [PLAN.md](PLAN.md) for the architecture, implementation milestones, acceptance tests, and effort estimates. It captures the current design from the Obsidian idea note, including:

- Responsive layouts for any screen size, with the Pixel 9 Fold as the primary mobile test device.
- One visible terminal with header swipes and previous/next buttons to navigate Herdr panes.
- Watch mode by default, explicit control, and release when switching panes.
- Persistent agents managed by Herdr, with supervised browser attachments and reconnect handling.
- Localhost serving behind Tailscale Serve.

## First milestone

Open a running OpenCode pane on the phone, watch it update, send a response, lock the phone, then reconnect without disturbing the running agent.

Start by validating the streaming subprocess integration and Herdr's viewport and control semantics, then build out navigation and the mobile experience.
