import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AttachmentId, PaneId } from "./domain.ts";
import type { ClientCommand } from "./domain.ts";
import { makeAttachment } from "./session.ts";
import { BrowserUi } from "./ui.ts";
import { BridgeTransport } from "./transport.ts";

const setup = Effect.gen(function* () {
  const input = yield* Queue.make<readonly (string | Uint8Array)[]>({
    capacity: 8,
  });
  const rendering = yield* Deferred.make<undefined>();
  const rendered = yield* Deferred.make<undefined>();
  const acked = yield* Deferred.make<undefined>();
  const sent: ClientCommand[] = [];
  let closed = false;
  const ui = BrowserUi.of({
    visible: Effect.succeed(true),
    events: Stream.empty,
    clear: Effect.void,
    render: () =>
      Deferred.succeed(rendering, undefined).pipe(
        Effect.andThen(Deferred.await(rendered)),
      ),
    showView: () => Effect.void,
    showPanes: () => Effect.void,
    notice: () => Effect.void,
    dimensions: Effect.succeedNone,
    setFont: () => Effect.void,
    composerActive: () => Effect.succeed(true),
    finishComposer: () => Effect.void,
  });
  const transport = BridgeTransport.of({
    discover: Effect.never,
    connect: () =>
      Effect.acquireRelease(
        Effect.succeed({
          read: Queue.take(input),
          send: (command: ClientCommand) =>
            Effect.sync(() => {
              sent.push(command);
            }).pipe(
              Effect.andThen(Deferred.succeed(acked, undefined)),
              Effect.asVoid,
            ),
        }),
        () =>
          Effect.sync(() => {
            closed = true;
          }),
      ),
  });
  const id = yield* Schema.decodeUnknownEffect(AttachmentId)(1);
  const pane = yield* Schema.decodeUnknownEffect(PaneId)("w1:p1");
  const attachment = yield* makeAttachment(id, pane, () => Effect.void).pipe(
    Effect.provideService(BrowserUi, ui),
    Effect.provideService(BridgeTransport, transport),
  );
  yield* Queue.offer(input, [
    '{"type":"mode","mode":"watch","generation":1,"reason":""}',
    '{"type":"frame","generation":1,"seq":1,"cols":80,"rows":24,"full":true}',
    new Uint8Array([27, 91, 50, 74]),
  ]);
  return { attachment, rendering, rendered, acked, sent, closed: () => closed };
});
describe("attachment scope and render acknowledgement", () => {
  it.effect(
    "a silent bridge times out and finalizes the connection without replaying input",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        yield* Deferred.succeed(test.rendered, undefined);
        const fiber = yield* test.attachment.run.pipe(
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.await(test.acked);
        yield* TestClock.adjust("21 seconds");
        assert.equal((yield* Fiber.join(fiber))._tag, "Failure");
        assert.isTrue(test.closed());
        assert.isFalse(test.sent.some((command) => command.type === "input"));
        const sent = test.sent.length;
        yield* TestClock.adjust("30 seconds");
        assert.equal(test.sent.length, sent);
      }),
  );
  it.effect("waits for terminal parsing before acknowledging", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const fiber = yield* Effect.forkChild(test.attachment.run);
      yield* Effect.yieldNow;
      assert.isTrue(yield* Deferred.isDone(test.rendering));
      assert.equal(test.sent.length, 0);
      yield* Deferred.succeed(test.rendered, undefined);
      yield* Deferred.await(test.acked);
      assert.equal(test.sent[0]?.type, "ack");
      yield* Fiber.interrupt(fiber);
      assert.isTrue(test.closed());
    }),
  );
  it.effect("cancels rendering without sending a late acknowledgement", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const fiber = yield* Effect.forkChild(test.attachment.run);
      yield* Effect.yieldNow;
      assert.isTrue(yield* Deferred.isDone(test.rendering));
      yield* Fiber.interrupt(fiber);
      yield* Deferred.succeed(test.rendered, undefined);
      yield* Effect.yieldNow;
      assert.equal(test.sent.length, 0);
      assert.isTrue(test.closed());
    }),
  );
});
