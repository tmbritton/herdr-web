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
- [ ] **2. Watch streaming:** WebSocket origin validation, watch-only attachment,
  browser asset build, xterm.js display with initial geometry and fresh snapshots.
  Test real WebSocket traffic and rendering; no input in watch mode.
- [ ] **3. Discovery/navigation:** Read-only pane/tab discovery, stable IDs and
  ordering, picker and header previous/next/swipes, one visible live attachment.
  Test changes in topology, fallback, and independent desktop focus.
- [ ] **4. Control:** Explicit acquire/takeover/release, input and resize
  validation, ownership display and release on switch/disconnect. Test conflicts,
  input delivery, geometry and return to watch mode against isolated Herdr.
- [ ] **5. Lifecycle:** Bound in-flight output, acknowledge rendered frames,
  heartbeat/stale-client cleanup, reconnect with a fresh view and no input replay.
  Test stalled consumers, CLI failure, closed panes and reconnects.
- [ ] **6. Phone workflow:** Responsive viewport/keyboard handling, font controls,
  touch keys and multiline paste-aware composer. Browser tests at narrow, wide,
  short and tall sizes; finish deployment and private-access documentation.

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
