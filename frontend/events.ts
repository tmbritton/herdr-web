import { Cause, Effect, Queue, Stream } from "effect";
import { EventOverflow, UiError } from "./domain.ts";

export function boundedEvents<A>(
  register: (emit: (event: A) => void) => () => void,
  capacity = 128,
): Stream.Stream<A, EventOverflow | UiError> {
  return Stream.callback<A, EventOverflow | UiError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () =>
            register((event) => {
              // DOM callbacks cannot suspend. Overflow terminates the owning scope;
              // silently discarding keystrokes would leave delivery ambiguous.
              if (!Queue.offerUnsafe(queue, event)) {
                Queue.failCauseUnsafe(queue, Cause.fail(new EventOverflow()));
                Queue.shutdownUnsafe(queue);
              }
            }),
          catch: () =>
            new UiError({ message: "Could not register browser events" }),
        }),
        (dispose) => Effect.sync(dispose),
      ),
    { bufferSize: capacity },
  );
}
