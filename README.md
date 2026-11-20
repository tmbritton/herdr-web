# Herdr Web Terminal Bridge

A mobile-friendly browser bridge to persistent Herdr terminal panes, built around Gleam on the BEAM, Mist, xterm.js, and private access through Tailscale Serve.

**Status:** Live watch streaming. Enter a pane ID to watch its rendered terminal
in xterm.js at `http://127.0.0.1:3000`. Pane discovery and interactive control are
the next implementation milestones. `/healthz` checks bridge liveness.

## Tooling and deployment choice

Use **mise for development** and a **systemd user service for deployment**.

- `mise.toml` pins Gleam, Erlang/OTP, and Rebar3 and provides project tasks.
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
mise run test     # Real HTTP integration test on an OS-assigned loopback port
mise run export   # Production bundle in build/erlang-shipment/
```

Unit tests do not require Herdr. The optional `mise exec -- npm run test:integration`
creates and cleans up its own named Herdr session and runs real WebSocket and
Chromium checks. Install Chromium once with `mise exec -- npx playwright install
chromium`. Existing panes are not used by the test.

For watch mode, enter a stable pane ID from `herdr pane list`. The terminal keeps
the stream's dimensions and can be panned horizontally. Browser input is disabled.
Frames are acknowledged only after xterm.js processes them; reconnecting creates
a fresh attachment.

Configuration is read at startup:

| Variable | Default / purpose |
| --- | --- |
| `HERDR_WEB_PORT` | `3000`, always bound to loopback |
| `HERDR_WEB_SESSION` | Unset: use the default Herdr session |
| `HERDR_WEB_ORIGINS` | Comma-separated exact origins; defaults to `http://127.0.0.1:3000,http://localhost:3000` |
| `HERDR_WEB_EXECUTABLE` | `herdr`; override the CLI executable path if necessary |

For Tailscale Serve, include its exact HTTPS origin in `HERDR_WEB_ORIGINS` and
restart the bridge. WebSocket requests require both an allowed Origin and Host.

### Quality checks and native dependencies

Gleam's standard formatter is `gleam format`; its compiler provides type and lint
diagnostics. `mise run check` checks formatting, runs `gleam check`, builds with
`--warnings-as-errors`, and compiles Erlang interoperability modules with
`erlc -Werror`. Browser code uses TypeScript, ESLint and Prettier, plus Node's test
runner. The installed pre-commit hook runs `check` and `test`; reinstall it
with `mise run hooks:install` after cloning or changing the hook.

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

On Linux with systemd, make `herdr` available on your shell's `PATH`, then:

```bash
mise run service:install
mise run service:start
systemctl --user status herdr-web.service
curl --fail http://127.0.0.1:3000/healthz
```

Stop any foreground development instance first; both use port 3000.

The installer builds and copies an independent production snapshot into
`~/.local/share/herdr-web/releases/`, points `current` at it, and installs
[`deploy/herdr-web.service`](deploy/herdr-web.service) into
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/`. It records the resolved Erlang and
Herdr binary directories in the snapshot's `runtime.env`, so systemd does not
depend on interactive shell initialization. The installer itself does not start
or restart the service.

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
src/herdr_web/web.gleam   HTTP routes and placeholder landing page
test/                    Gleeunit runner and HTTP integration test
deploy/                  systemd user-service definition
scripts/                 Local deployment installer
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
