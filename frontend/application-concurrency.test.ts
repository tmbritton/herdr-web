import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Snapshot } from "./domain.ts";
import type { ControlLease, WatchLease } from "./domain.ts";
import { runApplication } from "./application.ts";
import { boundedEvents } from "./events.ts";
import { PreferenceStore } from "./preferences.ts";
import { BridgeTransport } from "./transport.ts";
import { BrowserUi } from "./ui.ts";
import type { UiEvent } from "./ui.ts";

it.effect("drains saturated input queues and still handles page hiding", () =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(Snapshot)({
      result: {
        snapshot: {
          workspaces: [{ workspace_id: "w1", label: "Work", number: 1 }],
          tabs: [
            { tab_id: "w1:t1", workspace_id: "w1", label: "Tab", number: 1 },
          ],
          panes: [
            {
              pane_id: "w1:p1",
              terminal_id: "term1",
              workspace_id: "w1",
              tab_id: "w1:t1",
            },
          ],
          layouts: [],
        },
      },
    });
    const wire = yield* Queue.make<readonly (string | Uint8Array)[]>();
    const watching = yield* Deferred.make<WatchLease>();
    const controlling = yield* Deferred.make<ControlLease>();
    const writing = yield* Deferred.make<undefined>();
    const unblock = yield* Deferred.make<undefined>();
    const drained = yield* Deferred.make<undefined>();
    const closed = yield* Deferred.make<undefined>();
    let writes = 0;
    let emit: Option.Option<(event: UiEvent) => void> = Option.none();
    const ui = BrowserUi.of({
      visible: Effect.succeed(true),
      events: boundedEvents<UiEvent>((callback) => {
        emit = Option.some(callback);
        return () => {
          emit = Option.none();
        };
      }).pipe(Stream.merge(Stream.never)),
      clear: Effect.void,
      render: () => Effect.void,
      notice: () => Effect.void,
      showPanes: () => Effect.void,
      dimensions: Effect.succeedNone,
      setFont: () => Effect.void,
      composerActive: () => Effect.succeed(true),
      finishComposer: () => Effect.void,
      showView: (_pane, view) =>
        Effect.gen(function* () {
          if (view._tag === "Watching")
            yield* Deferred.succeed(watching, view.lease);
          if (view._tag === "Controlling")
            yield* Deferred.succeed(controlling, view.lease);
        }),
    });
    const transport = BridgeTransport.of({
      discover: Effect.succeed(snapshot),
      connect: () =>
        Effect.acquireRelease(
          Effect.succeed({
            read: Queue.take(wire),
            send: (command) =>
              Effect.gen(function* () {
                if (command.type === "control") {
                  yield* Queue.offer(wire, [
                    '{"type":"mode","mode":"requesting-control","generation":2,"reason":""}',
                    '{"type":"mode","mode":"control","generation":2,"reason":""}',
                    '{"type":"frame","generation":2,"seq":1,"cols":80,"rows":24,"full":true}',
                    new Uint8Array([27]),
                  ]);
                }
                if (command.type === "input") {
                  writes++;
                  if (writes === 1) {
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(unblock);
                  }
                  if (writes === 201)
                    yield* Deferred.succeed(drained, undefined);
                }
              }),
          }),
          () => Deferred.succeed(closed, undefined),
        ),
    });
    yield* Queue.offer(wire, [
      '{"type":"mode","mode":"watch","generation":1,"reason":""}',
      '{"type":"frame","generation":1,"seq":1,"cols":80,"rows":24,"full":true}',
      new Uint8Array([27]),
    ]);
    const fiber = yield* runApplication.pipe(
      Effect.provideService(BrowserUi, ui),
      Effect.provideService(BridgeTransport, transport),
      Effect.provideService(PreferenceStore, {
        load: Effect.succeed({}),
        save: () => Effect.void,
      }),
      Effect.forkChild,
    );
    const watch = yield* Deferred.await(watching);
    Option.getOrThrow(emit)({ _tag: "Control", lease: watch, takeover: false });
    const lease = yield* Deferred.await(controlling);
    const input: UiEvent = { _tag: "Input", lease, text: "x" };
    Option.getOrThrow(emit)(input);
    yield* Deferred.await(writing);
    for (let i = 0; i < 100; i++) Option.getOrThrow(emit)(input);
    yield* Effect.yieldNow;
    for (let i = 0; i < 100; i++) Option.getOrThrow(emit)(input);
    yield* TestClock.adjust("1 second");
    yield* Deferred.succeed(unblock, undefined);
    yield* Deferred.await(drained);
    assert.equal(writes, 201);
    Option.getOrThrow(emit)({ _tag: "Visibility", visible: false });
    yield* Deferred.await(closed);
    yield* Fiber.interrupt(fiber);
  }),
);
