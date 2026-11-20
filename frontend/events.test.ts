import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { boundedEvents } from "./events.ts";

describe("callback event boundaries", () => {
  it.effect("fails rather than silently dropping input on overflow", () =>
    Effect.gen(function* () {
      let released = false;
      const source = boundedEvents<number>((emit) => {
        for (let value = 0; value < 20; value++) emit(value);
        return () => {
          released = true;
        };
      }, 4);
      assert.isTrue(yield* Effect.isFailure(Stream.runCollect(source)));
      assert.isTrue(released);
    }),
  );
  it.effect("unregisters callbacks when its consumer is interrupted", () =>
    Effect.gen(function* () {
      let active = 0;
      const source = boundedEvents<number>(() => {
        active++;
        return () => {
          active--;
        };
      });
      const fiber = yield* source.pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(active, 1);
      yield* Fiber.interrupt(fiber);
      assert.equal(active, 0);
    }),
  );
});
