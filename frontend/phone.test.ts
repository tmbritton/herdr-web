import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { deliverPrompt, keyInput, pasteInput, terminalInput } from "./phone.ts";

it.effect(
  "encodes touch keys and one-shot Ctrl without losing Unicode input",
  () =>
    Effect.gen(function* () {
      assert.equal(yield* keyInput("Escape", false), "\x1b");
      assert.equal(yield* keyInput("Tab", false), "\t");
      assert.equal(yield* keyInput("ArrowUp", false), "\x1b[A");
      assert.equal(yield* keyInput("ArrowLeft", true), "\x1b[1;5D");
      assert.equal(yield* keyInput("ControlC", false), "\x03");
      assert.equal(yield* keyInput("Enter", false), "\r");
      assert.equal(yield* terminalInput("c", true), "\x03");
      assert.equal(yield* terminalInput("🙂", false), "🙂");
      assert.isTrue(yield* Effect.isFailure(terminalInput("word", true)));
      assert.isTrue(yield* Effect.isFailure(terminalInput("ß", true)));
      assert.isTrue(yield* Effect.isFailure(keyInput("unknown", false)));
    }),
);

it.effect(
  "never sends a delayed Enter after the prompt loses its attachment",
  () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(true);
      const delivered: string[] = [];
      const fiber = yield* deliverPrompt(
        "hello",
        "bracketed",
        true,
        Ref.get(current),
        (text) =>
          Effect.sync(() => {
            delivered.push(text);
          }),
      ).pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(delivered.length, 1);
      yield* Ref.set(current, false);
      yield* TestClock.adjust("200 millis");
      assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
      assert.deepEqual(delivered, ["\x1b[200~hello\x1b[201~"]);
    }),
);
it.effect("composes multiline paste using an explicit paste mode", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* pasteInput("one\r\ntwo\r", "bracketed"),
      "\x1b[200~one\ntwo\n\x1b[201~",
    );
    assert.equal(yield* pasteInput("one\ntwo", "plain"), "one\rtwo");
    assert.isTrue(yield* Effect.isFailure(pasteInput("", "bracketed")));
    assert.isTrue(
      yield* Effect.isFailure(
        pasteInput("text\x1b[201~injection", "bracketed"),
      ),
    );
    assert.isTrue(
      yield* Effect.isFailure(pasteInput("\u009b201~", "bracketed")),
    );
    assert.isTrue(
      yield* Effect.isFailure(pasteInput("🙂".repeat(4096), "bracketed")),
    );
  }),
);
