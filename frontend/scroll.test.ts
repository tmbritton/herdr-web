import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { View, ViewCols } from "./domain.ts";
import { coalescedScroll } from "./scroll.ts";
import type { ScrollSample, ScrollView } from "./scroll.ts";
import type { ScrollIntent } from "./machine.ts";
import { deliverPrompt } from "./phone.ts";

const controlling = Effect.fnUntraced(function* (attachment: number) {
  const view = yield* Schema.decodeUnknownEffect(View)({
    _tag: "Controlling",
    lease: { attachment, generation: 1 },
    seq: 1,
    cols: 80,
    rows: 24,
  });
  if (view._tag !== "Controlling")
    return yield* Effect.die("expected control view");
  return view;
});

it.effect(
  "accepted movement cancels a pending Enter before the scroll batch is sent",
  () =>
    Effect.gen(function* () {
      const view = yield* controlling(1);
      let push: (sample: ScrollSample) => void = () => {};
      let composerActive = true;
      const sent: string[] = [];
      const scrolling = yield* coalescedScroll(
        () => view,
        (send) => {
          push = send;
          return () => {};
        },
        () => {
          composerActive = false;
        },
      ).pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            sent.push("scroll");
          }),
        ),
        Effect.forkChild,
      );
      const submission = yield* deliverPrompt(
        "hello",
        "bracketed",
        true,
        Effect.sync(() => composerActive),
        (text) =>
          Effect.sync(() => {
            sent.push(text);
          }),
      ).pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("80 millis");
      push({ view, steps: 1, column: 0, row: 0, time: 80 });
      yield* TestClock.adjust("40 millis");
      assert.equal((yield* Fiber.join(submission))._tag, "Failure");
      assert.deepEqual(sent, ["\x1b[200~hello\x1b[201~", "scroll"]);
      yield* Fiber.interrupt(scrolling);
    }),
);

it.effect("coalesces fractional wheel movement and caps bursts", () =>
  Effect.gen(function* () {
    const view = yield* controlling(1);
    const received = yield* Queue.make<ScrollIntent>();
    let push: (sample: ScrollSample) => void = () => {};
    let disposed = false;
    const fiber = yield* coalescedScroll(
      () => view,
      (send) => {
        push = send;
        return () => {
          disposed = true;
        };
      },
    ).pipe(
      Stream.runForEach((event) => Queue.offer(received, event)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    const sample = { view, column: 10, row: 4, time: 0 };
    for (let i = 0; i < 3; i++) push({ ...sample, steps: -0.4 });
    yield* TestClock.adjust("32 millis");
    assert.deepEqual<unknown>((yield* Queue.take(received)).scroll, {
      direction: "up",
      steps: 1,
      column: 10,
      row: 4,
    });
    push({ ...sample, steps: -0.8, time: 40 });
    yield* TestClock.adjust("64 millis");
    assert.equal((yield* Queue.take(received)).scroll.steps, 1);
    push({ ...sample, steps: 100000, time: 100 });
    yield* TestClock.adjust("64 millis");
    assert.equal((yield* Queue.take(received)).scroll.steps, 8);
    yield* Fiber.interrupt(fiber);
    assert.isTrue(disposed);
  }),
);

it.effect(
  "discards pending movement after ownership/geometry loss and scope exit",
  () =>
    Effect.gen(function* () {
      const first = yield* controlling(1),
        next = yield* controlling(2);
      let current: ScrollView | undefined = first;
      const received: ScrollIntent[] = [];
      let push: (sample: ScrollSample) => void = () => {};
      const fiber = yield* coalescedScroll(
        () => current,
        (send) => {
          push = send;
          return () => {};
        },
      ).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            received.push(event);
          }),
        ),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      push({ view: first, steps: 3, column: 0, row: 0, time: 0 });
      current = undefined;
      yield* TestClock.adjust("40 millis");
      assert.equal(received.length, 0);
      current = next;
      push({ view: first, steps: 3, column: 0, row: 0, time: 50 });
      push({ view: next, steps: 1, column: 0, row: 0, time: 50 });
      yield* TestClock.adjust("40 millis");
      assert.equal(received.length, 1);
      assert.equal(received[0]?.lease.attachment, next.lease.attachment);
      push({ view: next, steps: 3, column: 0, row: 0, time: 100 });
      current = {
        ...next,
        cols: yield* Schema.decodeUnknownEffect(ViewCols)(40),
      };
      yield* TestClock.adjust("40 millis");
      assert.equal(received.length, 1);
      current = next;
      push({ view: next, steps: 3, column: 0, row: 0, time: 150 });
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("1 second");
      assert.equal(received.length, 1);
    }),
);
