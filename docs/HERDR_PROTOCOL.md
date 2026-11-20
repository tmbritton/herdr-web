# Herdr integration observations

Verified against installed **Herdr 0.8.2**, using a disposable named headless
session rather than the user's running panes. Source cross-check: upstream tag
`v0.8.2`, `src/client/mod.rs` and `src/app/api/panes.rs`.

- `terminal session observe <pane-id>` emits newline-delimited JSON:
  `type=terminal.frame`, `seq`, `encoding=ansi`, `width`, `height`, `full`, `bytes`.
  `bytes` is base64-encoded rendered ANSI, not the raw PTY byte stream.
- The first record has `full=true` and repaints the screen, including cursor
  placement. Every new attachment must start from this record; incremental frames
  cannot be arbitrarily dropped.
- The default stream viewport is 120×40 even if desktop layout dimensions differ.
  Observe does not take terminal input/resize ownership. The browser must render
  the geometry in the record, not fit an observer to its container.
- **Observers ignore stdin EOF.** Closing a pipe is not sufficient cleanup.
  `erlexec` manages/reaps each CLI OS process and ties it to its OTP worker.
- `control` emits the same frames, accepts JSON `terminal.input` (`text` or
  base64 `bytes`), `terminal.resize` (`cols`, `rows`), `terminal.scroll`, and
  `terminal.release`. Release exits successfully. `--takeover` is explicit.
- Version 0.8.2 has no `terminal.mouse` command, despite newer documentation.
- Rendered ANSI does not necessarily reproduce the application's input modes.
  In particular, do not infer bracketed-paste state from the rendered frame.
  `pane run` uses Herdr's atomic text-and-Enter input encoder; `pane send-text`
  sends raw text. The web composer uses an explicit bracketed/plain choice and
  stays on the owned controller stream. It never uses the separate pane-input
  API, which would bypass stream-controller ownership.
- Source verification in `server/headless.rs::apply_terminal_attach_input` shows
  that stream input is forwarded directly to the PTY. `protocol/render_ansi.rs`
  paints cells/cursor state without forwarding bracketed-paste mode. Composer
  submissions clear only the matching, unchanged draft after successful delivery
  to the controller stream. Failed/cancelled sends retain drafts, and an optional
  delayed Enter rechecks ownership/visibility.
- `herdr api snapshot` returns coherent workspace, tab, pane and layout metadata
  in one read-only request, including stable IDs and desktop focus. It is preferable
  to joining several independent list calls for navigation.
- Moving a pane to another workspace changes its public `pane_id` while retaining
  `terminal_id`. Navigation reconciles by terminal identity before closure fallback.

The transport caps queued output at 1 MiB / 128 records, delivers records only on
demand, caps stderr at 4 KiB and input writes at 64 KiB, and monitors the attachment
owner. Overflow closes the attachment; recovery requires a new full view.
Because the CLI protocol does not acknowledge stdin consumption, each attachment
also has a **1 MiB lifetime input budget**. Exhausting it closes the attachment;
the user must reacquire control. This bounds erlexec's native stdin queue even
when a child stops reading. No uncertain input is automatically replayed.
