import { Terminal } from "@xterm/xterm";
import { Renderer } from "./renderer.ts";
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

function watch(target: string) {
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

document
  .querySelector<HTMLFormElement>("#attach")!
  .addEventListener("submit", (event) => {
    event.preventDefault();
    watch(pane.value);
  });
window.addEventListener("pagehide", () => {
  renderer?.dispose();
  socket?.close();
});
