# Herdr Web Terminal Bridge

## Current implementation

The bridge provides a Gleam/Mist HTTP server bound to `127.0.0.1:3000`, live
watch-mode terminal streaming into xterm.js, exact WebSocket-origin validation,
bounded subprocess buffering, pane discovery/navigation and a `/healthz` liveness
endpoint. Explicit acquisition, takeover, input, resize and release are implemented.
Initial-frame, rendered-frame and heartbeat deadlines bound attachment lifetimes;
recovery always returns to watch mode. Phone keys, a prompt composer, font sizing
and visual-viewport handling are implemented. `TASKS.md` tracks deployment and
remaining physical-device acceptance checks.

The integration spike verified the installed Herdr 0.8.2 against disposable
workloads; findings are in `docs/HERDR_PROTOCOL.md`. `erlexec` manages OS subprocess
lifetimes through a small Erlang OTP worker, with typed Gleam protocol handling.
Browser assets are built with esbuild, TypeScript, Effect 4.1.4 and xterm.js.
The frontend uses schema-validated boundaries, nominal identities, typed errors,
control capabilities and scoped services/fibers. See `docs/EFFECT_FRONTEND.md`.

Development uses mise-pinned Gleam, Erlang/OTP, and Rebar3. Production deployment
uses `gleam export erlang-shipment` and a systemd **user** service. The installer
copies a separate snapshot and records resolved runtime paths, so the service
does not compile on startup or depend on shell initialization. User lingering
allows it to start at boot and survive logout. This keeps the bridge in the same
user environment as the existing Herdr server without container socket mounts.
See `README.md` for setup, verification, and service-management commands.

## Idea

Build a small web server in **Gleam on the BEAM** that lets a browser view and interact with an existing Herdr terminal pane. If that pane runs OpenCode, the browser sees the same live OpenCode TUI as the terminal client.

The primary use case is **checking on coding agents from a phone and occasionally intervening**, with private access through **Tailscale Serve**. It is also a practical project for learning Gleam and OTP.

The primary phone is a **Pixel 9 Fold**. Responsive behavior is a core requirement: the interface should adapt to any screen or window size, including folding, rotation, split-screen, and the software keyboard opening during a session.

## Why

OpenCode's web view and a separately launched terminal session do not automatically share the same backend and session. Herdr already keeps terminal panes alive and supports attaching clients to them; a browser bridge would make those persistent panes accessible from a web page.

## Architecture

```text
Phone, tablet, or desktop browser
  └─ Terminal renderer + responsive controls
       ↕ HTTPS / WebSocket
Tailscale Serve
       ↕ localhost
Gleam application
  ├─ HTTP + WebSocket server
  ├─ Pane discovery
  └─ Attachment workers
       ↕ stdin/stdout, newline-delimited JSON
Herdr CLI
       ↕
Existing Herdr server and terminal panes
```

Herdr owns the persistent terminals. Closing the browser or restarting the bridge should only interrupt the attachment; the agent keeps running.

### Proposed stack

| Component | Choice |
| --- | --- |
| Backend | Gleam targeting Erlang |
| HTTP and WebSockets | Mist |
| Attachment lifecycle | Gleam actors and OTP supervision |
| Herdr integration | CLI streaming through Erlang ports |
| Browser terminal | xterm.js with a small JavaScript/TypeScript UI |
| Remote access | Tailscale Serve |

Mist supports delivering custom process messages to WebSocket handlers, which fits forwarding terminal output from an attachment worker.

The subprocess integration needs an early investigation. The checked `gleam_erlang` port module exposes the port type, but not a complete subprocess API. Budget for a small Erlang interoperability module or a suitable package to manage a long-running CLI's stdin, stdout, and exit status.

### Why BEAM fits

Connection lifecycle, message passing, and failure isolation are the main benefits. Each attachment worker can own its Herdr CLI stream, translate input, forward output, and clean up independently.

- Supervise service components and isolate attachment failures.
- Release control and clean up the CLI attachment on disconnect; detect stale connections when a phone sleeps.
- Bound output buffering so a slow or sleeping browser cannot accumulate an unlimited backlog. Reattach for a fresh view when necessary; do not discard arbitrary ANSI chunks and assume the display remains valid.
- Restore attachments after failure without automatically replaying input whose delivery is uncertain.

## Responsive terminal experience

Use container dimensions and available height to drive the layout. Avoid device-specific assumptions: an unfolded screen with the keyboard open can be wide but short.

| Available space | Interface |
| --- | --- |
| Narrow | One terminal, pane navigation in a compact header, pane picker in a drawer, touch-key toolbar |
| Wider | Optional pane sidebar and more visible controls |
| Short, including landscape with keyboard open | Collapse secondary controls and prioritize terminal height |

Start with **one active terminal and quick switching between panes**. Extra space improves readability and navigation; multiple simultaneously visible terminals can come later.

### Pane navigation

Treat each Herdr tab's panes as a set of pages on the phone, with one pane filling the terminal area.

- **Navigate in the header:** Previous/next buttons and horizontal swipes on the pane header switch panes. Keep terminal-area gestures available for panning, selection, and application input.
- Show the tab, active pane name, and position, such as **OpenCode · Pane 2/3**. Position dots can supplement the label.
- Tapping the title or position indicator opens the pane picker, with names and available last-seen previews.
- Preserve Herdr's tab groupings and use a predictable pane order. Track the selected pane by identity so additions or rearrangements do not unexpectedly change the selection; choose a predictable remaining pane if it closes.
- Keep browser selection independent of desktop focus. Flipping through panes on the phone should leave the desktop user's focus alone.

Only the visible pane needs a live terminal stream initially. Inactive panes may retain clearly marked last-seen previews; selecting a pane attaches to it and refreshes its view.

**Control rule:** Leaving a pane releases browser control and closes its attachment. Arriving at another pane starts in watch mode; taking control is an explicit action for that pane.

The same header navigation works folded and unfolded. With more space, add a persistent pane list. A miniature overview of the Herdr layout, followed by multiple visible terminals, can be later enhancements.

### Terminal geometry and ownership

- **Watch mode:** Preserve the stream's terminal geometry, with panning and adjustable font size. Watching on a phone should leave the desktop terminal's dimensions and input ownership alone.
- **Control mode:** Offer fitting the terminal to the available container. Calculate columns and rows and send changed dimensions to Herdr.
- Keep text readable by default. Offer horizontal panning when an application's preferred width exceeds the screen.

xterm.js's FitAddon can calculate available columns and rows. Apply that calculation according to the attachment mode; fitting the browser component alone does not determine how the underlying terminal should resize.

Herdr supports multiple read-only observers and one terminal-stream controller at a time. A Control action should show whether takeover is needed. Verify the interaction between the stream controller and Herdr's ordinary TUI client before promising seamless handoff.

### Folding, rotation, and keyboard changes

1. Observe the terminal container with `ResizeObserver`.
2. Account for the visible viewport when the software keyboard appears.
3. Coalesce resize events and send only changed, valid dimensions when controlling.
4. Preserve the terminal instance, selected pane, and connection where the browser allows.
5. If Android suspends or reloads the page, restore the selected attachment and obtain a fresh terminal view.

### Mobile controls

- Thumb-accessible `Esc`, `Tab`, arrows, `Ctrl`, and `Ctrl+C`.
- A multiline prompt composer for Android keyboard input, dictation, and editing, with submission that respects the application's paste behavior.
- Adjustable terminal font size.
- Clear watch/control status and a release-control action.
- Controls that remain reachable above the software keyboard.

**Verified protocol constraint and composer decision:** Herdr 0.8.2 forwards
controller input as raw bytes and does not expose bracketed-paste state in the
rendered ANSI stream. The composer therefore offers an explicit bracketed/plain
paste choice, defaults to bracketed paste, and sends through the controller
stream. It keeps drafts until the user clears them and revalidates ownership
before a delayed Enter. This avoids assuming paste mode or using a separate pane
API that bypasses stream ownership. See `docs/HERDR_PROTOCOL.md`.

## Tailscale deployment

Bind the Gleam application to `127.0.0.1:3000`, then expose it privately through Tailscale Serve:

```bash
tailscale serve --bg --https=10000 http://127.0.0.1:3000
```

The phone connects through Tailscale and opens the Serve HTTPS URL. Serve handles TLS, and tailnet access rules control who can reach the service. For this personal tool, restricted tailnet access can provide the access boundary without a separate account system. Keep the backend localhost-only and validate the browser's WebSocket origin.

Inspect existing Serve routes before choosing a port. The initial deployment uses
HTTPS port 10000 alongside existing services on 443 and 8443. Configure the exact
HTTPS origin in `~/.config/herdr-web/environment`; the unit reads that optional
file separately from its installed runtime snapshot. See README for commands.

## Implementation plan

1. **Prove the integration:** Connect Gleam to `herdr terminal session observe <target>`. Parse newline-delimited JSON `terminal.frame` messages, decode the base64 ANSI bytes, and forward them over a WebSocket to xterm.js. Verify initial display state, frame behavior, and how a fresh attachment restores the view.
2. **Discover and navigate panes:** Use `herdr pane list` and the tab/layout metadata needed to group and order panes. Add header previous/next buttons, header swipes, and a responsive pane picker. Track selection by pane identity, stream only the visible pane, and start each new attachment in watch mode. Release control and close the previous attachment when switching.
3. **Add interaction:** Use `herdr terminal session control <target>` and translate browser events to `terminal.input` and `terminal.resize`. Implement explicit takeover and release; verify ownership behavior with the desktop TUI. Add scroll and mouse support as needed.
4. **Handle lifecycle:** Manage `terminal.closed`, CLI failures, stopped panes, stale connections, browser refreshes, and reconnects. Bound buffering and avoid input replay.
5. **Make the phone workflow usable:** Implement responsive sizing, keyboard controls, prompt composition, and the Pixel Fold transition tests. Exercise access through Tailscale Serve early.

## Acceptance tests

**First useful milestone:** Open a running OpenCode pane on the phone, watch it update, send a response, lock the phone, then reconnect without disturbing the running agent.

**Pixel Fold test:** Open a pane on the outer display, unfold it, open the keyboard, send a prompt, rotate, enter split-screen, then fold and reconnect. Preserve the selected pane and running agent throughout; preserve the connection where the browser permits.

**Pane navigation test:** Open a tab with multiple panes and switch using both header swipes and buttons. Confirm that terminal-area gestures do not switch panes, desktop focus stays unchanged, leaving a controlled pane releases control, and the destination opens in watch mode. Add, rearrange, and close panes while browsing; verify stable selection and predictable fallback. Last-seen previews should be clearly distinguished from live output.

Supplement real-device testing with narrow, wide, short, and tall browser viewports. Check that watch mode does not resize the desktop terminal, control handoff is predictable, controls remain reachable, and disconnects do not leave an attachment holding control indefinitely.

## Complexity estimate

| Milestone | Estimate |
| --- | --- |
| Prove Herdr → Gleam → browser streaming | 1–2 days |
| Pane selection, interactive control, and lifecycle handling | Another 2–3 days |
| Phone controls, resizing, reconnect-on-wake, and Tailscale testing | Another 2–4 days |

Budget **roughly 1–2 weeks of focused work for a useful personal version**, with extra time for learning Gleam and OTP from scratch. These estimates replace the initial generic bridge estimate and include the mobile-first scope.

Overall complexity: **moderate**. The main uncertainties are subprocess integration, Herdr viewport/control semantics, and phone keyboard/reconnection behavior. Responsive layout and reconnects belong in the initial architecture.

The installed Herdr version checked during planning was **0.8.2**. Its CLI help exposes both `terminal session observe` and `control`; end-to-end behavior still needs the integration spike.

## References

- [Herdr persistence and remote access: terminal streams](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/persistence-remote.mdx)
- [Herdr CLI reference](https://github.com/herdrdev/herdr/blob/master/docs/versions/0.9.5/website/src/content/docs/cli-reference.mdx)
- [Mist HTTP and WebSocket server](https://github.com/rawhat/mist)
- [Gleam Erlang port module](https://hexdocs.pm/gleam_erlang/gleam/erlang/port.html)
- [xterm.js FitAddon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
