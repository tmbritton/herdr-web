export interface TerminalSink {
  resize(cols: number, rows: number): void;
  reset(): void;
  write(data: Uint8Array, done: () => void): void;
}

export class Renderer {
  private terminal: TerminalSink;
  private ack: (seq: number) => void;
  private pending?: { seq: number; cols: number; rows: number; full: boolean };
  private seq = 0;
  private writing = false;
  private disposed = false;
  constructor(terminal: TerminalSink, ack: (seq: number) => void) {
    this.terminal = terminal;
    this.ack = ack;
  }
  receive(data: string | ArrayBuffer): void {
    if (this.disposed) return;
    if (typeof data === "string") {
      const meta = JSON.parse(data) as Record<string, unknown>;
      if (
        meta.type !== "frame" ||
        this.pending ||
        this.writing ||
        !Number.isSafeInteger(meta.seq) ||
        typeof meta.seq !== "number" ||
        meta.seq <= this.seq ||
        typeof meta.cols !== "number" ||
        !Number.isInteger(meta.cols) ||
        meta.cols < 1 ||
        meta.cols > 1000 ||
        typeof meta.rows !== "number" ||
        !Number.isInteger(meta.rows) ||
        meta.rows < 1 ||
        meta.rows > 500 ||
        typeof meta.full !== "boolean" ||
        (this.seq === 0 && !meta.full)
      )
        throw new Error("Invalid terminal frame");
      this.pending = {
        seq: meta.seq,
        cols: meta.cols,
        rows: meta.rows,
        full: meta.full,
      };
      return;
    }
    const frame = this.pending;
    if (!frame || this.writing || data.byteLength > 1048576)
      throw new Error("Unexpected terminal bytes");
    this.pending = undefined;
    if (this.seq === 0) this.terminal.reset();
    this.terminal.resize(frame.cols, frame.rows);
    this.seq = frame.seq;
    this.writing = true;
    this.terminal.write(new Uint8Array(data), () => {
      if (!this.disposed && this.writing) {
        this.writing = false;
        this.ack(frame.seq);
      }
    });
  }
  dispose(): void {
    this.disposed = true;
  }
}
