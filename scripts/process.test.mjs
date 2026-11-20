import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { stopDetached } from "./process.mjs";

async function fixture(t, ignoreTerm) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""} console.log("ready"); setInterval(() => {}, 1000);`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Independent cleanup ensures even the deliberately failing test cannot leak.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(2000) });
      process.kill(-child.pid, "SIGKILL");
      await exited;
    }
  });
  await once(child.stdout, "data", { signal: AbortSignal.timeout(2000) });
  return child;
}

test("waits for a detached process to terminate", async (t) => {
  const child = await fixture(t, false);
  await stopDetached(child, { graceMs: 1000, killMs: 1000 });
  assert.equal(child.signalCode, "SIGTERM");
  await stopDetached(child); // Already reaped: no later PID-based signal.
});

test("escalates an ignored SIGTERM and waits for SIGKILL termination", async (t) => {
  const child = await fixture(t, true);
  await stopDetached(child, { graceMs: 50, killMs: 1000 });
  assert.equal(child.signalCode, "SIGKILL");
});
