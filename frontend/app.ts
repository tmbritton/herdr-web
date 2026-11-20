import { Terminal } from "@xterm/xterm";
import { Renderer } from "./renderer.ts";
import { panesFromSnapshot, selectPane, type Pane } from "./navigation.ts";
import "./style.css";

const terminal = new Terminal({
  cols: 120,
  rows: 40,
  fontSize: 14,
  disableStdin: true,
  scrollback: 2000,
  screenReaderMode: true,
  theme: { background: "#10151c" },
});
terminal.open(document.querySelector<HTMLElement>("#terminal")!);
const status = document.querySelector<HTMLElement>("#status")!;
const pane = document.querySelector<HTMLInputElement>("#pane")!;
let socket: WebSocket | undefined;
let renderer: Renderer | undefined;
let panes: Pane[] = [];
let selected: string | undefined;
let selectedTerminal: string | undefined;
try {
  selected = localStorage.getItem("herdr-pane") ?? undefined;
  selectedTerminal = localStorage.getItem("herdr-terminal") ?? undefined;
} catch {
  /* storage is optional */
}
const picker = document.querySelector<HTMLSelectElement>("#picker")!;
const position = document.querySelector<HTMLElement>("#position")!;
const previous = document.querySelector<HTMLButtonElement>("#previous")!;
const next = document.querySelector<HTMLButtonElement>("#next")!;
const discovery = document.querySelector<HTMLElement>("#discovery")!;

function watch(target: string) {
  selected = target;
  selectedTerminal = panes.find((p) => p.id === target)?.terminalId;
  pane.value = target;
  try {
    localStorage.setItem("herdr-pane", target);
    if (selectedTerminal)
      localStorage.setItem("herdr-terminal", selectedTerminal);
    else localStorage.removeItem("herdr-terminal");
  } catch {
    /* storage is optional */
  }
  updateNavigation();
  renderer?.dispose();
  socket?.close();
  // Queue the clear after any already-buffered write from the previous pane.
  terminal.write("", () => terminal.reset());
  let received = false;
  const connection = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(target)}`,
  );
  connection.binaryType = "arraybuffer";
  socket = connection;
  const view = new Renderer(terminal, (seq) => {
    if (socket === connection && connection.readyState === WebSocket.OPEN) {
      received = true;
      status.textContent = `Watching ${target} · read-only`;
      connection.send(JSON.stringify({ type: "ack", seq }));
    }
  });
  renderer = view;
  status.textContent = `Connecting to ${target}…`;
  connection.onmessage = (event) => {
    if (socket !== connection) return;
    try {
      if (
        typeof event.data === "string" &&
        JSON.parse(event.data).type === "error"
      ) {
        status.textContent = `Disconnected: ${String(JSON.parse(event.data).reason)}`;
        connection.close();
        return;
      }
      view.receive(event.data as string | ArrayBuffer);
    } catch {
      status.textContent = "Invalid stream; attach again for a fresh view";
      connection.close();
    }
  };
  connection.onclose = () => {
    view.dispose();
    if (socket === connection)
      status.textContent = received
        ? `Disconnected from ${target} · last seen output`
        : `Unable to attach to ${target}`;
  };
}

function updateNavigation() {
  const index = panes.findIndex((p) => p.id === selected);
  const active = panes[index];
  const siblings = panes.filter((p) => p.tabId === active?.tabId);
  position.textContent = active
    ? `${active.group} · ${active.label} · ${siblings.findIndex((p) => p.id === active.id) + 1}/${siblings.length}`
    : "No pane selected";
  picker.value = selected ?? "";
  previous.disabled = index <= 0;
  next.disabled = index < 0 || index >= panes.length - 1;
}
function move(delta: number) {
  const target = panes[panes.findIndex((p) => p.id === selected) + delta];
  if (target) watch(target.id);
}
previous.addEventListener("click", () => move(-1));
next.addEventListener("click", () => move(1));
picker.addEventListener("change", () => watch(picker.value));
let refreshing = false;
let poll: ReturnType<typeof setTimeout>;
async function refresh() {
  clearTimeout(poll);
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/panes", {
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Discovery unavailable");
    const updated = panesFromSnapshot(await response.json());
    const target = selectPane(panes, updated, selected, selectedTerminal);
    panes = updated;
    picker.replaceChildren();
    let group: HTMLOptGroupElement | undefined;
    let tab: string | undefined;
    for (const item of panes) {
      if (tab !== item.tabId) {
        group = document.createElement("optgroup");
        group.label = item.group;
        picker.append(group);
        tab = item.tabId;
      }
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      group!.append(option);
    }
    if (target && (target !== selected || !socket)) watch(target);
    else if (!target) {
      selected = undefined;
      renderer?.dispose();
      socket?.close();
      socket = undefined;
      terminal.write("", () => terminal.reset());
      status.textContent = "No terminal panes are available";
    }
    updateNavigation();
    discovery.textContent = panes.length
      ? ""
      : "Create a pane in Herdr to begin";
  } catch {
    discovery.textContent = "Pane list unavailable · retrying";
  } finally {
    refreshing = false;
    if (!document.hidden)
      poll = setTimeout(() => {
        void refresh();
      }, 5000);
  }
}
document.querySelector("#refresh")!.addEventListener("click", () => {
  void refresh();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
  else clearTimeout(poll);
});
const navigation = document.querySelector<HTMLElement>("#pane-nav")!;
let gesture: { x: number; y: number; id: number } | undefined;
navigation.addEventListener("pointerdown", (event) => {
  if ((event.target as Element).closest("button")) return;
  gesture = { x: event.clientX, y: event.clientY, id: event.pointerId };
  navigation.setPointerCapture(event.pointerId);
});
navigation.addEventListener("pointerup", (event) => {
  if (
    gesture?.id === event.pointerId &&
    Math.abs(event.clientX - gesture.x) > 48 &&
    Math.abs(event.clientY - gesture.y) < 40
  )
    move(event.clientX < gesture.x ? 1 : -1);
  gesture = undefined;
});
navigation.addEventListener("pointercancel", () => {
  gesture = undefined;
});
void refresh();

document
  .querySelector<HTMLFormElement>("#attach")!
  .addEventListener("submit", (event) => {
    event.preventDefault();
    watch(pane.value);
  });
window.addEventListener("pagehide", () => {
  clearTimeout(poll);
  renderer?.dispose();
  socket?.close();
});
