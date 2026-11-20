export interface Pane {
  id: string;
  terminalId: string;
  label: string;
  group: string;
  tabId: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid discovery response");
  return value as Record<string, unknown>;
}
function array(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid discovery list");
  return value.map(object);
}
const text = (value: unknown, fallback: string) =>
  typeof value === "string" && value ? value : fallback;
const order = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : Number.MAX_SAFE_INTEGER;
export function panesFromSnapshot(value: unknown): Pane[] {
  const snapshot = object(object(object(value).result).snapshot);
  const workspaces = new Map(
    array(snapshot.workspaces).map((w) => [w.workspace_id, w]),
  );
  const tabs = new Map(array(snapshot.tabs).map((t) => [t.tab_id, t]));
  const positions = new Map<string, Record<string, unknown>>();
  for (const layout of array(snapshot.layouts)) {
    for (const pane of array(layout.panes))
      positions.set(String(pane.pane_id), object(pane.rect));
  }
  const seen = new Set<string>();
  return array(snapshot.panes)
    .map((p) => {
      const id = String(p.pane_id);
      if (!/^w[1-9]\d*:p[1-9]\d*$/.test(id) || seen.has(id))
        throw new Error("Invalid pane identity");
      seen.add(id);
      const workspace = workspaces.get(p.workspace_id) ?? {};
      const tab = tabs.get(p.tab_id) ?? {};
      const rect = positions.get(id) ?? {};
      return {
        id,
        terminalId: text(p.terminal_id, id),
        label: text(p.label, text(p.title, id)),
        tabId: String(p.tab_id),
        group: `${text(workspace.label, String(p.workspace_id))} / ${text(tab.label, String(p.tab_id))}`,
        rank: [
          order(workspace.number),
          order(tab.number),
          order(rect.y),
          order(rect.x),
        ],
      };
    })
    .sort((a, b) => {
      for (let index = 0; index < a.rank.length; index++) {
        const diff = a.rank[index]! - b.rank[index]!;
        if (diff) return diff;
      }
      return a.id.localeCompare(b.id, "en", { numeric: true });
    })
    .map(({ id, terminalId, label, group, tabId }) => ({
      id,
      terminalId,
      label,
      group,
      tabId,
    }));
}
export function selectPane(
  old: Pane[],
  next: Pane[],
  selected: string | undefined,
  rememberedTerminal?: string,
): string | undefined {
  if (next.some((p) => p.id === selected)) return selected;
  const terminal =
    old.find((p) => p.id === selected)?.terminalId ?? rememberedTerminal;
  const moved = next.find((p) => terminal && p.terminalId === terminal);
  if (moved) return moved.id;
  const index = Math.max(
    0,
    old.findIndex((p) => p.id === selected),
  );
  return next[Math.min(index, next.length - 1)]?.id;
}
