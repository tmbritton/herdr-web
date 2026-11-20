# Implementation tasks

Each feature uses red → green → refactor, required checks, an independent
code-review sub-agent, fixes for actionable findings, then a commit and push.
Record verification and remaining real-device checks here. `PLAN.md` remains the
design source of truth.

- [x] **0. Baseline:** Commit the scaffold and task plan; close unread HTTP request
  bodies safely. Verify the initial service packaging.
- [x] **1. Herdr adapter:** Verify 0.8.2 on an isolated session. Implement bounded
  NDJSON framing, strict protocol decoding, and a monitored Erlang-port worker.
  Tests cover fragmented lines, malformed/oversized output, exits and cleanup.
- [x] **2. Watch streaming:** WebSocket origin validation, watch-only attachment,
  browser asset build, xterm.js display with initial geometry and fresh snapshots.
  Test real WebSocket traffic and rendering; no input in watch mode.
- [x] **3. Discovery/navigation:** Read-only pane/tab discovery, stable IDs and
  ordering, picker and header previous/next/swipes, one visible live attachment.
  Test changes in topology, fallback, and independent desktop focus.
- [x] **3a. Effect frontend:** Runtime schemas and branded domain types, typed
  state/capability transitions, scoped browser services, bounded event streams,
  Effect-aware tests and compiler diagnostics. See `docs/EFFECT_FRONTEND.md`.
  This user-requested foundation takes priority over completing control.
- [x] **4. Control:** Explicit acquire/takeover/release, input and resize
  validation, ownership display and release on switch/disconnect. Test conflicts,
  input delivery, geometry and return to watch mode against isolated Herdr.
- [x] **5. Lifecycle:** Bound in-flight output, acknowledge rendered frames,
  heartbeat/stale-client cleanup, reconnect with a fresh view and no input replay.
  Test stalled consumers, CLI failure, closed panes and reconnects.
- [x] **6. Phone workflow:** Responsive viewport/keyboard handling, font controls,
  touch keys and multiline paste-aware composer. Browser tests at narrow, wide,
  short and tall sizes, then review/commit/push.
- [x] **7. Deployment:** Install and validate the final systemd snapshot; configure
  private access without disturbing existing Serve routes; document device checks.

## Validation boundaries

Automate integration against disposable test workloads. Existing user panes and
agents must remain undisturbed. Actual Pixel Fold transitions and phone sleep
require a later hands-on check; report them separately from browser simulation.

## Progress

- Baseline review found unread request bodies could be interpreted as a second
  request on a persistent HTTP connection. The split-body regression test failed
  before the fix; ordinary responses now close the connection.
- Initial adapter tests failed before implementation. Coverage includes protocol
  decoding, fragmented lines, demand/credit, stdin, stderr/exit codes, overflow,
  truncated records and owner-death cleanup. Review-driven regression tests also
  failed before fixes for cumulative stdin limits, prompt cleanup and exit races.
  Probe findings are in `docs/HERDR_PROTOCOL.md`.
- Standard Gleam formatting/compiler diagnostics and Erlang warnings-as-errors
  are required by `check`; the installed pre-commit hook runs `check` and `test`.
- Watch-stream renderer and origin/target tests failed before implementation.
  Real Herdr/Chromium integration verifies full frames, fresh reattachment,
  rejected origins/input, unchanged desktop layout/focus and observer cleanup.
  The hook now includes TypeScript, ESLint, Prettier and browser unit tests.
- Discovery consumes one successful bounded CLI snapshot. Selection/order tests
  failed before implementation. Real browser checks cover automatic selection,
  additions, previous/next, header swipes, terminal gesture isolation, closure
  fallback, one retained terminal instance and unchanged desktop focus.
- Effect migration and control implementation passed independent review. Red tests
  covered malformed boundaries, explicit-control state transitions, scoped socket
  cleanup, bounded writes, renderer cancellation, callback overflow, page hiding
  and migration of stored selection. Real Herdr/Chromium tests exercise input,
  conflict/takeover, release, fit and release-on-navigation.
- Review found bounded-queue self-publication could deadlock the dispatcher, and
  a blocked storage getter could fail Layer construction. Both had failing
  regressions before fixes; the re-review approved the changes. Full checks,
  18 Gleam tests, 25 Effect tests and real Herdr/Chromium integration passed.
- Lifecycle tests failed before implementation. Deadlines cover initial frames,
  rendered acknowledgements and client idle time; real WebSocket unit tests use
  isolated subprocess fixtures. Effect TestClock verifies heartbeat cancellation
  and silent-bridge cleanup. Real Herdr integration withholds a controller's ACK
  while continuing heartbeats, then checks release and fresh watch recovery.
  Independent review approved the change; 24 Gleam and 27 Effect tests, compiler/
  lint/format checks, and real Herdr/Chromium integration passed.
- Phone key/paste encoding and delayed-Enter cancellation had failing tests before
  implementation. The composer uses an explicit paste style because 0.8.2 does
  not export that mode. Browser checks cover touch keys, multiline paste, drafts,
  font persistence, picker/header gestures, short layouts and stable connections
  across viewport changes. Physical-device/OpenCode acceptance remains manual.
- Phone review found the delayed Enter blocked release/navigation in the dispatcher.
  A failing application-level test reproduced paste → Enter → release. Scoped,
  request-identified submission fibers now cancel on release, input, navigation,
  hide, reconnect and ownership loss. Four lifecycle regressions pass. The Ctrl+C
  browser assertion now requires executed output, not echoed input. Re-review
  approved; checks, 24 Gleam tests, 34 Effect tests and browser integration passed.
- Deployment configuration had a failing installed-service check (403 for the
  configured Serve Host) before adding the optional service environment file;
  the check now passes. HTTPS health/discovery and WSS origin validation have
  passed through private Serve on port 10000. The integration suite now runs the
  exported shipment and verifies that a controlled workload survives bridge
  shutdown/restart with its shell state intact.
- Packaging review found a shutdown timeout could discard the bridge handle.
  A failing OS-process regression now covers an ignored SIGTERM; bounded cleanup
  retains ownership, escalates to SIGKILL when needed, and awaits termination.
  Both helper tests, the full unit gates, and production-shipment integration pass.
- Final packaging re-review approved. The installed user service is active and
  enabled with lingering enabled. Local and private HTTPS/WSS smoke tests pass;
  Serve uses port 10000 alongside the existing 443/8443 endpoints. Physical-device,
  live OpenCode and desktop-TUI acceptance checks below are not claimed as tested.

## Follow-up: composer submission

- [x] Clear unchanged drafts after successful submission and make toolbar Enter
  submit a focused composer draft. Browser regressions failed first for retaining
  submitted text, then for Enter failing to deliver the focused draft. Preserve
  paste-only, failed/cancelled and newly edited drafts.
  Checks, unit tests, and real Herdr/Chromium regressions pass; independent review
  approved the change.

## Follow-up: full session history

- [x] Add control-gated Home/End/Page keys and a separate read-only full-history
  view. Key and browser tests failed before implementation. A real OpenCode 1.19.5
  probe found the TUI's 100-message cap; the user chose a separate transcript view.
  The view uses the pane's reported session ID and bounded read-only SQLite pages.
  Initial browser checks reached the beginning of 240 messages, preserved long
  Unicode output, rejected changed sessions and left database bytes unchanged.
- Independent review found NUL truncation in SQLite text operations, omitted
  interrupted-tool output and a harness-specific test temp path. Regressions now
  cover these cases. Re-review approved; checks, 26 Gleam tests, 38 Effect tests,
  two process-helper tests, production-shipment browser integration and packaging
  validation passed.

## Remaining hands-on acceptance

- [ ] Pixel 9 Fold: outer display → unfold → keyboard/dictation → rotation →
  split-screen → fold → lock/unlock; keep selected pane and running agent.
- [ ] Real OpenCode TUI: watch an active turn, take control, submit a prompt with
  the matching paste style, release and reconnect.
- [ ] Desktop TUI: verify preferred control takeover/release and geometry handoff
  while a desktop client is present.
- [ ] Confirm phone access under the tailnet's ACLs and boot/logout behavior on
  the next normal reboot (service enablement/lingering are checked separately).
- [ ] Full history: read from Beginning through multiple pages on the phone and
  return to the live terminal; verify any customized OpenCode navigation bindings.
