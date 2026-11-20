import { Effect, Option, Schema } from "effect";
import { ProtocolError, Snapshot } from "./domain.ts";
import type { Pane, Selection } from "./domain.ts";
export type { Pane } from "./domain.ts";

export function normalize(snapshot: Snapshot): readonly Pane[] {
  const source = snapshot.result.snapshot;
  const workspaces = new Map(source.workspaces.map((w) => [w.workspace_id, w]));
  const tabs = new Map(source.tabs.map((t) => [t.tab_id, t]));
  const positions = new Map(
    source.layouts.flatMap((layout) =>
      layout.panes.map((p) => [p.pane_id, p.rect] as const),
    ),
  );
  return source.panes
    .map((p) => {
      const workspace = workspaces.get(p.workspace_id);
      const tab = tabs.get(p.tab_id);
      const rect = positions.get(p.pane_id);
      return {
        id: p.pane_id,
        terminalId: p.terminal_id,
        tabId: p.tab_id,
        label: p.label || p.title || p.pane_id,
        group: `${workspace?.label ?? p.workspace_id} / ${tab?.label ?? p.tab_id}`,
        rank: [
          workspace?.number ?? Number.MAX_SAFE_INTEGER,
          tab?.number ?? Number.MAX_SAFE_INTEGER,
          rect?.y ?? Number.MAX_SAFE_INTEGER,
          rect?.x ?? Number.MAX_SAFE_INTEGER,
        ] as const,
      };
    })
    .sort(
      (a, b) =>
        a.rank[0] - b.rank[0] ||
        a.rank[1] - b.rank[1] ||
        a.rank[2] - b.rank[2] ||
        a.rank[3] - b.rank[3] ||
        a.id.localeCompare(b.id, "en", { numeric: true }),
    )
    .map(({ id, terminalId, label, group, tabId }) => ({
      id,
      terminalId,
      label,
      group,
      tabId,
    }));
}

const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);
export const panesFromSnapshot = Effect.fn("panesFromSnapshot")(
  (value: unknown) =>
    decodeSnapshot(value).pipe(
      Effect.map(normalize),
      Effect.mapError(
        () => new ProtocolError({ message: "Invalid pane discovery response" }),
      ),
    ),
);

export function selectPane(
  old: readonly Pane[],
  next: readonly Pane[],
  selected: Option.Option<Selection>,
): Option.Option<Pane> {
  const previous = Option.getOrUndefined(selected);
  const exact = next.find((p) => p.id === previous?.paneId);
  if (exact !== undefined) return Option.some(exact);
  const terminal =
    old.find((p) => p.id === previous?.paneId)?.terminalId ??
    previous?.terminalId;
  const moved = next.find(
    (p) => terminal !== undefined && p.terminalId === terminal,
  );
  if (moved !== undefined) return Option.some(moved);
  const index = Math.max(
    0,
    old.findIndex((p) => p.id === previous?.paneId),
  );
  return Option.fromUndefinedOr(next[Math.min(index, next.length - 1)]);
}

export const selectionOf = (pane: Pane): Selection => ({
  paneId: pane.id,
  terminalId: pane.terminalId,
});
