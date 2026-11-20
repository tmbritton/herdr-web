import { Effect, Option } from "effect";
import type { ClientCommand, Generation, TransportError } from "./domain.ts";

export const heartbeat = Effect.fn("heartbeat")(
  (
    generation: Effect.Effect<Option.Option<Generation>>,
    send: (command: ClientCommand) => Effect.Effect<void, TransportError>,
  ) =>
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("5 seconds");
        const current = yield* generation;
        if (Option.isSome(current))
          yield* send({ type: "ping", generation: current.value });
      }),
    ),
);
