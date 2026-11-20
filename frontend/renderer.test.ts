import assert from "node:assert/strict";
import { test } from "node:test";
import { Renderer } from "./renderer.ts";

test("rendered frames preserve geometry and acknowledge only after writing", () => {
  const actions: unknown[] = [];
  let complete = () => {};
  const renderer = new Renderer(
    {
      resize: (cols, rows) => actions.push([cols, rows]),
      reset: () => actions.push("reset"),
      write: (data, done) => {
        actions.push([...data]);
        complete = done;
      },
    },
    (seq) => actions.push(["ack", seq]),
  );
  renderer.receive(
    JSON.stringify({ type: "frame", seq: 1, cols: 120, rows: 40, full: true }),
  );
  renderer.receive(new Uint8Array([27, 91, 50, 74]).buffer);
  assert.deepEqual(actions, ["reset", [120, 40], [27, 91, 50, 74]]);
  complete();
  assert.deepEqual(actions.at(-1), ["ack", 1]);
  renderer.dispose();
  complete();
  assert.equal(actions.length, 4);
});

test("a fresh renderer rejects incremental or out-of-order bytes", () => {
  const renderer = new Renderer(
    { resize() {}, reset() {}, write() {} },
    () => {},
  );
  assert.throws(() => renderer.receive(new ArrayBuffer(0)));
  assert.throws(() =>
    renderer.receive(
      JSON.stringify({
        type: "frame",
        seq: 1,
        cols: 80,
        rows: 24,
        full: false,
      }),
    ),
  );
});
