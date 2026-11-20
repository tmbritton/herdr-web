import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Generation } from "./domain.ts";
import type { ClientCommand } from "./domain.ts";
import { heartbeat } from "./liveness.ts";

it.effect(
  "heartbeats are scoped to the current generation and stop on interruption",
  () =>
    Effect.gen(function* () {
      const generation = yield* Schema.decodeUnknownEffect(Generation)(3);
      const sent: ClientCommand[] = [];
      const fiber = yield* heartbeat(
        Effect.succeed(Option.some(generation)),
        (command) =>
          Effect.sync(() => {
            sent.push(command);
          }),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      assert.deepEqual<unknown>(sent, [{ type: "ping", generation: 3 }]);
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("30 seconds");
      assert.equal(sent.length, 1);
    }),
);
