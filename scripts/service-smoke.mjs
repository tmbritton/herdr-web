// Read-only checks for an installed bridge, optionally through Tailscale Serve.
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { Effect, Schema } from "effect";
import { ServerJson, Snapshot } from "../frontend/domain.ts";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:3000").origin;
const health = await fetch(`${origin}/healthz`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(health.status, 200);
assert.equal(await health.text(), "ok\n");
const discovery = await fetch(`${origin}/api/panes`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(discovery.status, 200);
const snapshot = await Effect.runPromise(
  Schema.decodeUnknownEffect(Snapshot)(await discovery.json()),
);

// Select a non-existent target, so this check does not observe any user output.
let index = 1;
const ids = new Set(snapshot.result.snapshot.panes.map((pane) => pane.pane_id));
while (ids.has(`w999999:p${index}`)) index++;
const url = `${origin.replace(/^http/, "ws")}/ws/w999999:p${index}`;
const accepted = new WebSocket(url, { origin });
accepted.on("error", () => {});
try {
  const signal = AbortSignal.timeout(10000);
  const [, [data]] = await Promise.all([
    once(accepted, "open", { signal }),
    once(accepted, "message", { signal }),
  ]);
  const record = await Effect.runPromise(
    Schema.decodeUnknownEffect(ServerJson)(data.toString()),
  );
  assert.equal(record.type, "error");
} finally {
  accepted.terminate();
}

const rejected = new WebSocket(url, { origin: "https://untrusted.example" });
rejected.on("error", () => {});
try {
  const [, response] = await once(rejected, "unexpected-response", {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.statusCode, 403);
} finally {
  rejected.terminate();
}
console.log(
  `PASS: ${origin} — health, ${snapshot.result.snapshot.panes.length} schema-validated panes, WebSocket upgrade and origin rejection`,
);
