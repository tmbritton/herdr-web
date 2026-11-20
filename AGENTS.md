# Agent Guide

## Project purpose and current state

Herdr Web Terminal Bridge is a mobile-friendly browser interface to existing,
persistent Herdr terminal panes. The main use case is checking on coding agents
from a phone and occasionally interacting with their live terminal UI. It is also
a practical project for learning Gleam and OTP.

The bridge serves an xterm.js terminal and `/healthz` on
`127.0.0.1:3000`. Supervised Herdr streams, exact WebSocket origins and bounded
output, pane discovery, header navigation and explicit control are implemented.
The frontend uses Effect 4.1.4. Initial-frame, render-ack and heartbeat deadlines
are implemented, along with phone keys, prompt composition, font sizing and
visual-viewport handling. See `TASKS.md` for remaining deployment/device checks.
Read-only full OpenCode history is available through a separate paginated view;
see `docs/HISTORY.md` for the storage contract and the TUI's 100-message limit.
`/healthz` only
checks bridge liveness. See `TASKS.md` for progress and `docs/HERDR_PROTOCOL.md`
for verified 0.8.2 behavior.

- Read `README.md` for the overview and first milestone.
- Read `PLAN.md` for the architecture, interaction rules, implementation sequence,
  acceptance tests, and known uncertainties. Treat it as the current design source
  of truth.
- Keep these documents and this guide aligned with implemented behavior and
  deliberate design changes.

## Structure and commands

- `src/herdr_web.gleam`: startup, loopback binding, and process lifetime.
- `src/herdr_web/web.gleam`: HTTP handler, browser assets and WebSocket routing.
- `src/herdr_web/socket.gleam`: attachment lifecycle and browser protocol.
- `src/herdr_web/history.gleam`: bounded, read-only OpenCode transcript queries.
- `src/herdr_web_process*.erl`: bounded subprocess transport and OTP supervision.
- `frontend/`: Effect/TypeScript schemas, services, state machine, xterm.js UI and tests.
- `test/herdr_web_test.gleam`: Gleeunit runner and real HTTP integration test.
- `deploy/herdr-web.service`: systemd user-service definition.
- `scripts/install-service.sh`: production snapshot and service installation.
- `gleam.toml`: dependencies; `manifest.toml`: generated dependency lockfile.
- `mise.toml`: pinned Gleam, Erlang/OTP, Rebar3, and project tasks.

Run commands from the project root:

```bash
mise trust
mise install
mise exec -- npm ci
mise run hooks:install
mise run dev      # http://127.0.0.1:3000
mise run format
mise run check   # Formatting, type checks, warnings-as-errors, Erlang compiler
mise run lint    # Gleam compiler lint checks
mise run build
mise run test    # Uses an OS-assigned loopback port; does not need Herdr
mise run export  # build/erlang-shipment/
```

Use the pinned toolchain, keep `manifest.toml` in version control, and let Gleam
update the lockfile. Rebar3 is required to build Mist's Erlang dependencies.
The pre-commit hook runs `mise run check` and `mise run test`. Never bypass it.
`erlexec` also requires Make and a C++17 compiler at build time. See README for
the local Bazzite/OpenSSL runtime-library override.
The asset task bundles `frontend/` into `priv/static/` with esbuild. Node/npm are
build-time dependencies. `check` also runs Effect's TypeScript compiler diagnostics,
type-aware ESLint and Prettier; `test` runs Gleam and Effect/Vitest tests (two workers).
`mise exec -- npm run test:integration` uses
a disposable named Herdr session plus Chromium (install it with Playwright).
It exports and runs the production shipment, including a bridge-restart test that
must preserve the separately managed workload. `npm run test:service -- <origin>`
is a read-only smoke test for an installed instance and its configured origin.

### Frontend correctness

Use **Effect 4**, following `docs/EFFECT_FRONTEND.md` and the pinned package's
`ai-docs/` and source. Do not mix v3 APIs into this application.

- Schema-decode external data and infer types from schemas. Preserve branded
  identities, bounded dimensions and distinct watch/control capabilities.
- Keep expected errors typed; use Context services and Layers for browser IO.
- Own sockets, listeners, polling and pending work through scopes and fibers.
  A reconnect creates a new attachment; never retry or replay terminal input.
- Preserve the protocol state machine's full-snapshot, generation, sequence and
  rendered-before-ack rules. No unchecked JSON casts or non-null assertions.
- Keep strict TypeScript, type-aware ESLint, Effect diagnostics and compile-time
  negative assertions in the pre-commit gate. Use Effect/Vitest and TestClock
  for cancellation, lifecycle and timeout tests.
- Keep composer delivery on the controller stream. Herdr 0.8.2 does not report
  paste mode: preserve the explicit bracketed/plain choice, per-terminal page-local
  drafts, and ownership/visibility recheck before Enter. Never auto-resubmit.
  Clear only an unchanged draft after successful submission; preserve newer edits
  and failed/cancelled drafts. Toolbar Enter submits a focused composer draft.
- Wheel and vertical single-touch scrolling require a current control lease.
  Preserve native horizontal panning/zoom and selection. Keep gesture batches
  bounded/scoped, recheck geometry and ownership, and never replay stale movement.

### Service deployment

Use mise for development and systemd for the installed application. The production
shipment needs Erlang at runtime, but not Gleam, Rebar3, or mise. Run as the same
user as Herdr. Full history also needs `sqlite3` with JSON support; the installer
records its binary directory. Keep database reads read-only, output bounded,
session identities pinned between pages, and transcript content rendered as text.
The bridge service must attach to separately managed persistent
workloads, not own their lifetime.

`mise run service:install` exports and installs an independent snapshot in
`~/.local/share/herdr-web/releases/` and a user unit. It records runtime paths and
updates the `current` symlink without starting/restarting the service. Use
`mise run service:start` to enable/start, `mise run service:logs` for logs, and
`mise run service:stop` before running development on the same port. After an
update, use `systemctl --user restart herdr-web.service`. Boot/logout behavior
depends on user lingering; see `README.md`.
Application settings live in optional `~/.config/herdr-web/environment`, separate
from generated release runtime paths. Validate exact origins when changing Serve
configuration and preserve any other services' routes.

## Intended architecture

```text
Browser (xterm.js + small JavaScript/TypeScript UI)
  ↕ HTTPS / WebSocket
Tailscale Serve
  ↕ localhost
Gleam on the BEAM (Mist + supervised attachment workers)
  ↕ long-running CLI stdin/stdout, newline-delimited JSON
Herdr CLI → existing Herdr server and terminal panes
```

- Herdr owns the persistent terminals and running agents. Browser disconnects,
  attachment failures, and bridge restarts must leave those workloads running.
- Use Gleam targeting Erlang, Mist for HTTP/WebSockets, and actors with OTP
  supervision for attachment lifecycle and failure isolation.
- Integrate with Herdr through CLI streams and Erlang ports. Investigate the
  subprocess API early; a small Erlang interoperability module or a suitable
  package may be necessary.
- Bind the backend to `127.0.0.1:3000`. Private remote access uses Tailscale Serve;
  tailnet access rules provide the intended access boundary. Validate browser
  WebSocket origins.

## Behavioral requirements

### Attachments and control

- Start every new pane attachment in **watch mode**. Taking control is explicit
  for that pane, with clear ownership, takeover, and release status/actions.
- Watching must preserve the stream's terminal geometry and leave desktop input
  ownership and terminal dimensions alone.
- In control mode, offer fitting to the available container. Coalesce resize
  events and send only changed, valid terminal dimensions.
- Leaving a pane releases browser control and closes its attachment. Disconnects
  and stale connections must also release control and clean up attachment
  processes.
- Bound output buffering. If a browser falls behind, reattach for a fresh view
  rather than dropping arbitrary ANSI chunks and assuming the display is valid.
- Reconnect without automatically replaying input whose delivery is uncertain.
- Handle closed panes, CLI failures, browser refreshes, and phone suspension as
  expected lifecycle events.

### Navigation and responsive UI

- Initially show one terminal and keep only the visible pane's stream live.
- Preserve Herdr tab groupings and predictable pane order. Track selection by
  pane identity, with a predictable fallback when the selected pane closes.
- Browser pane selection must be independent of desktop focus.
- Put previous/next buttons and pane-switching swipes in the header. Reserve
  terminal-area gestures for terminal interaction, selection, and panning.
- Provide a pane picker and clear active tab/pane/position labels. Distinguish
  any retained last-seen previews from live output.
- Size the UI from the terminal container and available viewport height, including
  keyboard changes. Support narrow, wide, short, and tall layouts rather than
  assuming a particular device size.
- The Pixel 9 Fold is the primary mobile test device. Preserve the selected pane,
  terminal instance, and connection through layout changes where possible;
  restore the attachment with a fresh view after suspension or reload.
- Keep text readable, support horizontal panning and adjustable font size, and
  keep touch controls reachable above the keyboard. Planned controls include
  `Esc`, `Tab`, arrows, `Ctrl`, `Ctrl+C`, and a multiline prompt composer that
  respects the terminal application's paste behavior.

## Implementation priorities

Follow the milestone order in `PLAN.md`:

1. Prove Herdr → Gleam → browser streaming using
   `herdr terminal session observe <target>`, newline-delimited `terminal.frame`
   messages, base64-decoded ANSI bytes, WebSockets, and xterm.js. Verify initial
   display state and fresh-attachment recovery.
2. Discover panes with `herdr pane list` and the required tab/layout metadata;
   implement stable selection, navigation, and watch-mode attachment switching.
3. Add explicit control using `herdr terminal session control <target>` and
   `terminal.input` / `terminal.resize`, including takeover and release.
4. Complete lifecycle handling, bounded buffering, and reconnect behavior.
5. Build out the phone workflow and exercise private access through Tailscale
   Serve early.

Design for responsive sizing and reconnects from the start. Multiple visible
terminals and a miniature layout overview are later enhancements.

The Herdr version checked during planning was **0.8.2**, while linked Herdr
references include **0.9.5** documentation. Verify the installed version and actual
protocol behavior before relying on version-specific details. Initial frame
semantics, viewport behavior, and controller interaction with the desktop TUI
remain integration-spike questions; CLI help alone does not establish them.

## Validation

Follow `TASKS.md` for feature-sized increments. For behavior changes, first add a
meaningful failing test, then implement and refactor. Run an independent code
review sub-agent before **every commit**, resolve actionable findings, then commit
and push the completed feature before moving to the next task. Preserve this
workflow in follow-up sessions.

Run `mise run check` and `mise run test` for application changes. For packaging
changes, also run `mise run export`, `bash -n scripts/install-service.sh`, and
`systemd-analyze --user verify deploy/herdr-web.service`; verify runtime startup
and shutdown when changing deployment behavior. Report what was actually verified.
Preserve these acceptance scenarios as implementation proceeds:

- **First useful milestone:** Open a running OpenCode pane on the phone, watch it
  update, send a response, lock the phone, then reconnect without disturbing the
  running agent.
- **Fold/keyboard workflow:** Start on the outer display, unfold, open the keyboard,
  send a prompt, rotate, enter split-screen, then fold and reconnect. Preserve the
  selected pane and running agent throughout.
- **Pane navigation:** Switch with header swipes and buttons; verify terminal
  gestures do not switch panes, desktop focus stays unchanged, leaving releases
  control, and the destination starts in watch mode. Add, rearrange, and close
  panes to check stable selection and fallback.
- **Geometry and lifecycle:** Check watch-mode non-interference, predictable
  control handoff, reachable controls, slow/sleeping clients, and eventual release
  after disconnect. Supplement real-device checks with varied browser viewports.
