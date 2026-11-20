import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { Frame } from "./domain.ts";
import { clearTerminal, writeTerminal } from "./terminal.ts";
import type { TerminalSink } from "./terminal.ts";

it.effect(
  "terminal callbacks are awaited and cancelled clears cannot erase a newer pane",
  () =>
    Effect.gen(function* () {
      let callback: Option.Option<() => void> = Option.none();
      let resets = 0;
      let finished = false;
      const terminal: TerminalSink = {
        cols: 80,
        rows: 24,
        resize() {},
        reset() {
          resets++;
        },
        write(_bytes, done) {
          callback = Option.some(done);
        },
      };
      const frame = yield* Schema.decodeUnknownEffect(Frame)({
        type: "frame",
        generation: 1,
        seq: 1,
        cols: 80,
        rows: 24,
        full: true,
      });
      const writer = yield* writeTerminal(
        terminal,
        frame,
        new Uint8Array([27]),
        true,
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            finished = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isFalse(finished);
      Option.getOrThrow(callback)();
      yield* Fiber.join(writer);
      assert.isTrue(finished);
      const clear = yield* Effect.forkChild(clearTerminal(terminal));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(clear);
      Option.getOrThrow(callback)();
      assert.equal(resets, 1);
    }),
);

it.effect("a stalled terminal parser has a bounded lifetime", () =>
  Effect.gen(function* () {
    const terminal: TerminalSink = {
      cols: 80,
      rows: 24,
      resize() {},
      reset() {},
      write() {},
    };
    const frame = yield* Schema.decodeUnknownEffect(Frame)({
      type: "frame",
      generation: 1,
      seq: 1,
      cols: 80,
      rows: 24,
      full: true,
    });
    const writer = yield* writeTerminal(
      terminal,
      frame,
      new Uint8Array([27]),
      true,
    ).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("6 seconds");
    assert.equal((yield* Fiber.join(writer))._tag, "Failure");
  }),
);
