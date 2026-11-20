import { assert, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { Pane } from "./domain.ts";
import { panesFromSnapshot, selectPane, selectionOf } from "./navigation.ts";

const pane = (id: string, terminalId = id) =>
  Schema.decodeUnknownEffect(Pane)({
    id,
    terminalId,
    label: id,
    group: "Work / Tab",
    tabId: "w1:t1",
  });
it.effect(
  "selection preserves identity and uses the old position after closure",
  () =>
    Effect.gen(function* () {
      const [one, two, three] = yield* Effect.all(
        [pane("w1:p1"), pane("w1:p2"), pane("w1:p3")] as const,
        { concurrency: 1 },
      );
      const old = [one, two, three];
      const selected = Option.some(selectionOf(two));
      assert.deepEqual(
        selectPane(old, [three, one, two], selected),
        Option.some(two),
      );
      assert.deepEqual(
        selectPane(old, [one, three], selected),
        Option.some(three),
      );
      assert.deepEqual(
        selectPane(old, [one], Option.some(selectionOf(three))),
        Option.some(one),
      );
      assert.isTrue(Option.isNone(selectPane(old, [], selected)));
    }),
);

it.effect(
  "selection follows a terminal across workspace-qualified ID changes",
  () =>
    Effect.gen(function* () {
      const original = yield* pane("w1:p1", "term-kept");
      const remaining = yield* pane("w1:p2", "term-other");
      const moved = yield* pane("w2:p1", "term-kept");
      const selected = Option.some(selectionOf(original));
      assert.deepEqual(
        selectPane([original, remaining], [remaining, moved], selected),
        Option.some(moved),
      );
      assert.deepEqual(
        selectPane([], [remaining, moved], selected),
        Option.some(moved),
      );
    }),
);

it.effect(
  "schemas validate discovery before preserving groups and layout order",
  () =>
    Effect.gen(function* () {
      const raw = {
        result: {
          snapshot: {
            workspaces: [{ workspace_id: "w1", number: 1, label: "Work" }],
            tabs: [
              {
                tab_id: "w1:t1",
                workspace_id: "w1",
                number: 1,
                label: "First",
              },
              {
                tab_id: "w1:t2",
                workspace_id: "w1",
                number: 2,
                label: "Second",
              },
            ],
            panes: [
              {
                pane_id: "w1:p3",
                terminal_id: "term3",
                workspace_id: "w1",
                tab_id: "w1:t2",
              },
              {
                pane_id: "w1:p1",
                terminal_id: "term1",
                workspace_id: "w1",
                tab_id: "w1:t1",
                label: "Agent",
              },
              {
                pane_id: "w1:p2",
                terminal_id: "term2",
                workspace_id: "w1",
                tab_id: "w1:t1",
              },
            ],
            layouts: [
              {
                panes: [
                  { pane_id: "w1:p1", rect: { x: 40, y: 0 } },
                  { pane_id: "w1:p2", rect: { x: 0, y: 0 } },
                ],
              },
            ],
          },
        },
      };
      const panes = yield* panesFromSnapshot(raw);
      assert.deepEqual(
        panes.map((p) => p.id),
        ["w1:p2", "w1:p1", "w1:p3"],
      );
      assert.equal(panes[1]?.label, "Agent");
      assert.equal(panes[1]?.terminalId, "term1");
      assert.equal(panes[0]?.group, "Work / First");
      assert.isTrue(
        yield* Effect.isFailure(
          panesFromSnapshot({ result: { snapshot: {} } }),
        ),
      );
      assert.isTrue(
        yield* Effect.isFailure(
          panesFromSnapshot({
            ...raw,
            result: {
              snapshot: {
                ...raw.result.snapshot,
                panes: [
                  ...raw.result.snapshot.panes,
                  raw.result.snapshot.panes[0],
                ],
              },
            },
          }),
        ),
      );
    }),
);
