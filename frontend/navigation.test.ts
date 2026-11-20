import assert from "node:assert/strict";
import { test } from "node:test";
import { panesFromSnapshot, selectPane, type Pane } from "./navigation.ts";

const pane = (id: string): Pane => ({
  id,
  terminalId: id,
  label: id,
  group: "Work / Tab",
  tabId: "w1:t1",
});
test("selection follows identity across additions/rearrangement and uses next position on close", () => {
  const old = [pane("w1:p1"), pane("w1:p2"), pane("w1:p3")];
  assert.equal(selectPane(old, [old[2]!, old[0]!, old[1]!], "w1:p2"), "w1:p2");
  assert.equal(selectPane(old, [old[0]!, old[2]!], "w1:p2"), "w1:p3");
  assert.equal(selectPane(old, [old[0]!], "w1:p3"), "w1:p1");
  assert.equal(selectPane(old, [], "w1:p2"), undefined);
});
test("pane order preserves workspace/tab grouping and row-major layout", () => {
  const raw = {
    result: {
      snapshot: {
        workspaces: [{ workspace_id: "w1", number: 1, label: "Work" }],
        tabs: [
          { tab_id: "w1:t2", number: 2, label: "Second" },
          { tab_id: "w1:t1", number: 1, label: "First" },
        ],
        panes: [
          { pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t2" },
          {
            pane_id: "w1:p1",
            workspace_id: "w1",
            tab_id: "w1:t1",
            label: "Agent",
            terminal_id: "term-agent",
          },
          { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1" },
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
  const panes = panesFromSnapshot(raw);
  assert.deepEqual(
    panes.map((p) => p.id),
    ["w1:p2", "w1:p1", "w1:p3"],
  );
  assert.equal(panes[1]?.label, "Agent");
  assert.equal(panes[1]?.terminalId, "term-agent");
  assert.equal(panes[0]?.group, "Work / First");
  assert.throws(() => panesFromSnapshot({ result: { snapshot: {} } }));
});

test("selection follows the terminal when Herdr changes its workspace-qualified pane ID", () => {
  const original = { ...pane("w1:p1"), terminalId: "term-kept" };
  const remaining = { ...pane("w1:p2"), terminalId: "term-other" };
  const moved = { ...original, id: "w2:p1", tabId: "w2:t1" };
  assert.equal(
    selectPane([original, remaining], [remaining, moved], original.id),
    moved.id,
  );
});
