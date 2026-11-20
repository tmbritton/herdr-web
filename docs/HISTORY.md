# Full OpenCode history

## Why a separate view

Herdr 0.8.2 streams rendered screen updates, not a transcript. Increasing xterm.js
scrollback cannot retrieve conversation text that was never sent to the browser.
The bridge's Top/Home, Bottom/End and Page Up/Down keys navigate the application
while controlling it. Mouse wheel/trackpad and vertical one-finger gestures now
use Herdr's application-aware scrolling in control mode as well. These gestures
remain subject to the application's retained-history limit.

A disposable OpenCode **1.19.5** session containing 240 messages demonstrated that
Home and Ctrl+G stop at message 141. Source verification in
`packages/tui/src/context/sync.tsx` shows an initial `limit: 100`, plus eviction of
older messages as new ones arrive. The user chose a separate read-only view to
reach the actual beginning rather than changing OpenCode itself.

## User workflow

1. Select the pane, then choose **Full history**. It opens in a new tab and works
   in watch mode. Returning to the terminal follows the ordinary visibility and
   reconnect rules.
2. Choose **Beginning** for the first stored message. Scroll within the page and
   use **Older**/**Newer** to read adjacent pages. **Latest** refreshes the end.
3. If the pane switches OpenCode sessions, reload History explicitly. Subsequent
   requests pin the original session ID and refuse to mix transcripts.

The transcript is plain text, including text/reasoning parts, tool inputs and
outputs (including retained interrupted output), file labels and compaction
markers. Binary attachments are represented by labels. Internal step/accounting
parts are omitted. Each request is a current database snapshot; the view does not
poll. Earlier edits/deletions can change page positions, and deleted/pruned content
cannot be recovered. This is OpenCode-specific; other terminal applications keep
their ordinary live view.

## Backend contract

`GET /api/history/<pane>?start=latest|<segment-offset>&session=<expected-id>`

- Validates the exact configured Host and canonical pane ID.
- Runs bounded `herdr pane get`, decoding `result.pane.agent_session` with
  `agent=opencode`, `kind=id` and a validated `ses_…` identity. No cwd-based guesses.
- On later requests, a different reported ID returns HTTP 409. Missing identity
  or absent database session returns 404; unavailable commands/schema return 503.
- Uses the supervised subprocess adapter and `sqlite3 -readonly -batch -init
  /dev/null`, fixed SQL and validated literals. Request parameters cannot choose a
  database or inject SQL. It never sends pane input, takes control or modifies
  OpenCode records.
- Uses the OpenCode 1.19.5 `session`, `message` and `part` tables, ordered by
  message creation time, message ID and part ID. Verified against a real database
  schema and a disposable imported session. Settings choose the database path
  and SQLite executable; see README.
- Computes segment ranges using window sums, then returns at most **16 segments
  of 4096 UTF-8 bytes**. Each segment includes up to three overlapping bytes to
  finish a codepoint, hex-encoded in JSON. SQLite BLOB operations preserve NUL
  bytes; UTF-8 decoding avoids splitting characters or stripping embedded BOMs.
  Huge messages and tool outputs continue on later pages rather than truncating.
- SQL output and subprocess duration remain bounded by the existing adapter.
  Responses use `Cache-Control: no-store`. An incompatible database schema yields
  a visible error instead of silently substituting another session.

`/history/<pane>` is a standalone Effect application. External data is schema
decoded, session IDs are branded, HTTP failures are typed, request switching
interrupts old work, and page scope owns listeners and pending requests. Transcript
content is inserted with `textContent`, never interpreted as HTML or terminal ANSI.

## Verification

- Real Herdr + Chromium: navigation in a 10,000-line redraw-only TUI, control
  gating, draft preservation, reload and release.
- Disposable SQLite transcript: 240 messages, beginning/end navigation, a very
  long Unicode/NUL-containing reply reconstructed across every page, interrupted
  tool output, text-only rendering, unchanged database bytes and session mismatch.
- Effect tests: malformed pages, UTF-8 boundary cases, NUL/BOM preservation, obsolete
  request cancellation, pinned identity and scope cleanup.
- Physical phone scrolling and user-specific OpenCode keybinding behavior remain
  hands-on acceptance checks.
