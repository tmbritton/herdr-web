import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Snapshot } from "./domain.ts";
import { runApplication } from "./application.ts";
import { BrowserUi } from "./ui.ts";
import type { UiEvent } from "./ui.ts";
import { BridgeTransport } from "./transport.ts";
import { PreferenceStore } from "./preferences.ts";

it.effect(
  "switches scopes without overlap and resumes hidden pages in a new attachment",
  () =>
    Effect.gen(function* () {
      const events = yield* Queue.make<UiEvent>();
      const connections = yield* Queue.make<string>();
      const closures = yield* Queue.make<undefined>();
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
              {
                pane_id: "w1:p2",
                terminal_id: "term2",
                workspace_id: "w1",
                tab_id: "w1:t1",
              },
            ],
            layouts: [],
          },
        },
      });
      let active = 0;
      let maximum = 0;
      const opened: string[] = [];
      const trace: string[] = [];
      const transport = BridgeTransport.of({
        discover: Effect.sync(() => {
          trace.push("discover");
          return snapshot;
        }),
        connect: (pane) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              active++;
              maximum = Math.max(maximum, active);
              opened.push(pane);
              return { read: Effect.never, send: () => Effect.void };
            }).pipe(Effect.tap(() => Queue.offer(connections, pane))),
            () =>
              Effect.sync(() => {
                active--;
              }).pipe(Effect.andThen(Queue.offer(closures, undefined))),
          ),
      });
      const ui = BrowserUi.of({
        visible: Effect.succeed(true),
        events: Stream.fromQueue(events),
        clear: Effect.void,
        render: () => Effect.void,
        showView: (_pane, view) =>
          Effect.sync(() => {
            trace.push(view._tag);
          }),
        showPanes: (list) =>
          Effect.sync(() => {
            trace.push(`panes:${list.length}`);
          }),
        notice: (message) =>
          Effect.sync(() => {
            trace.push(message);
          }),
        dimensions: Effect.succeedNone,
        setFont: () => Effect.void,
        composerActive: () => Effect.succeed(true),
        finishComposer: () => Effect.void,
      });
      const fiber = yield* runApplication.pipe(
        Effect.provideService(BrowserUi, ui),
        Effect.provideService(BridgeTransport, transport),
        Effect.provideService(PreferenceStore, {
          load: Effect.succeed({}),
          save: () => Effect.void,
        }),
        Effect.forkChild,
      );
      assert.equal(yield* Queue.take(connections), "w1:p1");
      assert.isUndefined(fiber.pollUnsafe());
      assert.deepEqual(opened, ["w1:p1"], trace.join(","));
      yield* Queue.offer(events, { _tag: "Select", value: "w1:p2" });
      assert.equal(yield* Queue.take(connections), "w1:p2");
      yield* Queue.take(closures);
      assert.deepEqual(opened, ["w1:p1", "w1:p2"]);
      assert.equal(active, 1);
      assert.equal(maximum, 1);
      yield* Queue.offer(events, { _tag: "Visibility", visible: false });
      yield* Queue.take(closures);
      yield* TestClock.adjust("10 seconds");
      assert.equal(active, 0);
      assert.equal(opened.length, 2);
      yield* Queue.offer(events, { _tag: "Visibility", visible: true });
      assert.equal(yield* Queue.take(connections), "w1:p2");
      assert.deepEqual(opened, ["w1:p1", "w1:p2", "w1:p2"]);
      yield* Fiber.interrupt(fiber);
      assert.equal(active, 0);
    }),
);
