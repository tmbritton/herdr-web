import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Snapshot, SubmissionId } from "./domain.ts";
import type { ControlLease, WatchLease } from "./domain.ts";
import { runApplication } from "./application.ts";
import { PreferenceStore } from "./preferences.ts";
import { BridgeTransport } from "./transport.ts";
import { BrowserUi } from "./ui.ts";
import type { UiEvent } from "./ui.ts";

it.effect.each(["release", "switch", "hide", "reconnect"] as const)(
  "%s cancels a composer that is waiting to send Enter",
  (action) =>
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
      const events = yield* Queue.make<UiEvent>();
      const wire = yield* Queue.make<readonly (string | Uint8Array)[]>();
      const watch = yield* Deferred.make<WatchLease>();
      const control = yield* Deferred.make<ControlLease>();
      const pasted = yield* Deferred.make<undefined>();
      const released = yield* Deferred.make<undefined>();
      const sent: string[] = [];
      const ui = BrowserUi.of({
        visible: Effect.succeed(true),
        events: Stream.fromQueue(events),
        clear: Effect.void,
        render: () => Effect.void,
        showPanes: () => Effect.void,
        notice: () => Effect.void,
        dimensions: Effect.succeedNone,
        setFont: () => Effect.void,
        composerActive: () => Effect.succeed(true),
        finishComposer: () => Effect.void,
        showView: (_pane, view) =>
          Effect.gen(function* () {
            if (view._tag === "Watching")
              yield* Deferred.succeed(watch, view.lease);
            if (view._tag === "Controlling")
              yield* Deferred.succeed(control, view.lease);
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
                  if (command.type === "control")
                    yield* Queue.offer(wire, [
                      '{"type":"mode","mode":"requesting-control","generation":2,"reason":""}',
                      '{"type":"mode","mode":"control","generation":2,"reason":""}',
                      '{"type":"frame","generation":2,"seq":1,"cols":80,"rows":24,"full":true}',
                      new Uint8Array([27]),
                    ]);
                  if (command.type === "input") {
                    sent.push(command.text);
                    yield* Deferred.succeed(pasted, undefined);
                  }
                  if (command.type === "release") {
                    sent.push("release");
                    yield* Deferred.succeed(released, undefined);
                  }
                }),
            }),
            () => Deferred.succeed(released, undefined),
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
      const watching = yield* Deferred.await(watch);
      yield* Queue.offer(events, {
        _tag: "Control",
        lease: watching,
        takeover: false,
      });
      const lease = yield* Deferred.await(control);
      const id = yield* Schema.decodeUnknownEffect(SubmissionId)(1);
      yield* Queue.offer(events, {
        _tag: "Compose",
        id,
        lease,
        text: "hello",
        style: "bracketed",
        submit: true,
      });
      yield* Deferred.await(pasted);
      const cancellation: UiEvent =
        action === "release"
          ? { _tag: "Release", lease }
          : action === "switch"
            ? { _tag: "Select", value: "w1:p2" }
            : action === "hide"
              ? { _tag: "Visibility", visible: false }
              : { _tag: "Reconnect" };
      yield* Queue.offer(events, cancellation);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("200 millis");
      yield* Deferred.await(released);
      assert.deepEqual(
        sent,
        action === "release"
          ? ["\x1b[200~hello\x1b[201~", "release"]
          : ["\x1b[200~hello\x1b[201~"],
      );
      yield* Fiber.interrupt(fiber);
    }),
);
