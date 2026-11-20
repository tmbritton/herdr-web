// Disposable TUI with history older than the browser attachment. Like OpenCode,
// it redraws a viewport; it never streams its complete history to the terminal.
// Herdr accepts its official OpenCode session reports only for a detected agent.
process.title = "opencode";
const total = 10000;
const rows = 20;
let top = total - rows;
let pending = "";
function render() {
  const lines = Array.from(
    { length: rows },
    (_, row) => `HISTORY_ROW_${String(top + row).padStart(5, "0")}`,
  );
  process.stdout.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`);
}
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h");
process.on("exit", () => {
  process.stdin.setRawMode(false);
  process.stdout.write("\x1b[?1049l");
});
process.stdin.on("data", (data) => {
  pending += data.toString();
  while (pending.length > 0) {
    if (pending.startsWith("\x03")) process.exit(0);
    const match = pending.startsWith("\x1b")
      ? /^\[(H|F|5~|6~)/.exec(pending.slice(1))
      : null;
    if (match) {
      switch (match[1]) {
        case "H":
          top = 0;
          break;
        case "F":
          top = total - rows;
          break;
        case "5~":
          top = Math.max(0, top - rows);
          break;
        case "6~":
          top = Math.min(total - rows, top + rows);
          break;
      }
      pending = pending.slice(match[0].length + 1);
      render();
    } else if (["\x1b", "\x1b[", "\x1b[5", "\x1b[6"].includes(pending)) {
      break;
    } else pending = pending.slice(1);
  }
});
render();
