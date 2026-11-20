# Effect frontend design

The frontend uses **Effect 4.1.4**, pinned with matching browser/test packages.
The v4 documentation and the installed package sources are authoritative; v3
examples use different Schema, service, stream and error-handling APIs.

## Correctness boundaries

- Schema-decode every HTTP response, WebSocket text record, stored preference,
  manually entered pane ID and terminal dimension. Infer TypeScript types from
  the schemas; validate before applying nominal brands.
- Distinguish pane IDs, terminal IDs, attachment IDs, generations, sequences and
  dimensions. A controlling state carries a control capability; watching and
  connecting states cannot construct terminal input commands.
- Use explicit tagged state transitions and typed failures. Reject malformed,
  stale, out-of-order and unexpected binary records. Acknowledge output only
  after the terminal parser completes the write.
- One scope owns one attachment. Switching panes, hiding/discarding the page,
  failures and interruption finalize its socket, pending work and listeners.
  The terminal instance belongs to the longer-lived page scope.
- Use Context services and Layers for HTTP/socket transport, terminal/UI access
  and preferences. Tests replace those services rather than global browser APIs.
- Use bounded queues and scoped fibers/streams for event processing, polling,
  retry and timers. Coalesce navigation/resize/read requests where appropriate;
  never silently drop or replay terminal input.
- A queue consumer must not await publication into its own bounded queue.
  Commands update the model directly; reader notifications wake the dispatcher,
  which projects the latest model rather than replaying obsolete UI states.
- Prompt submissions run as scoped fibers, allowing release/navigation to cancel
  a delayed Enter. Branded submission IDs prevent an older completion from
  modifying a newer pending draft. Drafts stay page-local and are never replayed.
- Enable strict TypeScript and type-aware ESLint plus Effect's compiler
  diagnostics. Tests include schema boundaries, state/capability transitions,
  cancellation, cleanup, backpressure and deterministic virtual-time cases.

## Source findings that affect this application

Read in the installed `effect` and `@effect/platform-browser` packages:

- `src/Schema.ts`: brands alone are type-only. `Schema.check` predicates and
  effectful decoding provide the runtime boundary. JSON parsing/encoding can be
  derived with `Schema.fromJsonString`.
- `src/socket/Socket.ts`: browser read buffering defaults to unbounded. Configure
  `highWaterMark`; overflow must terminate and obtain a new full snapshot.
  Writers wait on a latch while disconnected. Create a new socket per attachment,
  reject writes when not open and do not retry input. Bound native buffered writes.
- `src/Stream.ts` / `src/Queue.ts`: callback streams default to unbounded buffers;
  DOM event listeners cannot exert backpressure and bounded listeners may drop
  events. Input adapters must explicitly fail on overflow rather than drop bytes.
- `src/Effect.ts` / resource examples: acquisition/release and scoped child fibers
  finalize on failure and interruption. Keep resource scopes at the application
  and attachment boundaries; do not launch detached work from handlers.
- `BrowserRuntime.ts`: the built-in runner interrupts on non-persisted pagehide
  but deliberately ignores the back/forward cache. Handle persisted pagehide
  and visibility suspension explicitly, returning in watch mode on resumption.
- `BrowserHttpClient.ts` / `BrowserKeyValueStore.ts`: provide replaceable browser
  services with typed errors. Invalid/unavailable storage is recoverable, rather
  than a reason to fail the live terminal. The browser storage getter itself can
  throw during Layer construction, so acquisition is guarded before constructing
  `KeyValueStore.layerStorage`; an in-memory layer handles that case.

Effect makes lifetimes and failures explicit; it cannot guarantee delivery after
a network interruption or run asynchronous cleanup after a browser is killed.
The backend still owns authorization, stale-connection deadlines and process
cleanup. Reconnect always starts a new watch attachment and never replays input.

References: <https://effect.website/docs/v4/>, the pinned package's `ai-docs/`,
<https://github.com/Effect-TS/effect/tree/effect%404.1.4>, and
<https://github.com/Effect-TS/tsgo> for compiler diagnostics.
