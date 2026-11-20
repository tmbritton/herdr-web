// Real Herdr integration against a unique disposable session; never user panes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "@playwright/test";

const session = `herdr-web-test-${process.pid}-${Date.now().toString(36)}`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_")),
);
const cli = (...args) => {
  const output = execFileSync("herdr", ["--session", session, ...args], {
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  return output.trim() ? JSON.parse(output) : {};
};
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn("herdr", ["--session", session, "server"], {
  env,
  stdio: "ignore",
});
let bridge;
let browser;
let bridgeLog = "";
const sockets = [];
async function until(fn, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (await fn()) return;
    } catch {
      /* startup can race */
    }
    await sleep(100);
  }
  throw new Error(`Timeout: ${description}\n${bridgeLog}`);
}
function connect(pane, origin = base) {
  const ws = new WebSocket(
    `${base.replace("http", "ws")}/ws/${encodeURIComponent(pane)}`,
    { origin },
  );
  sockets.push(ws);
  ws.on("error", () => {});
  const queue = [];
  let waiting;
  ws.on("message", (data, binary) => {
    const value = { data, binary };
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(value);
    } else queue.push(value);
  });
  return {
    ws,
    next: () => {
      if (queue.length) return Promise.resolve(queue.shift());
      return Promise.race([
        new Promise((resolve) => {
          waiting = resolve;
        }),
        sleep(5000).then(() => {
          throw new Error("No websocket frame");
        }),
      ]);
    },
  };
}
async function frame(client, desiredMode) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const message = await client.next();
    assert.equal(message.binary, false);
    const meta = JSON.parse(message.data.toString());
    if (meta.type === "mode") {
      client.mode = meta.mode;
      client.generation = meta.generation;
      if (meta.reason) client.reason = meta.reason;
      continue;
    }
    assert.equal(meta.type, "frame", JSON.stringify(meta));
    const output = await client.next();
    assert.equal(output.binary, true);
    client.ws.send(
      JSON.stringify({
        type: "ack",
        generation: meta.generation,
        seq: meta.seq,
      }),
    );
    if (!desiredMode || client.mode === desiredMode)
      return { meta, output: output.data };
  }
  throw new Error(`Expected mode ${desiredMode}`);
}
function command(client, data) {
  client.ws.send(JSON.stringify({ ...data, generation: client.generation }));
}
try {
  await until(() => cli("pane", "list").result, "Herdr startup");
  const created = cli(
    "workspace",
    "create",
    "--cwd",
    process.cwd(),
    "--label",
    "Bridge integration",
    "--no-focus",
  );
  const pane = created.result.root_pane.pane_id;
  cli("pane", "run", pane, "printf 'WATCH_STREAM_MARKER\\n'");
  await sleep(200);
  const before = cli("api", "snapshot").result.snapshot;
  bridge = spawn("gleam", ["run"], {
    detached: true,
    env: {
      ...env,
      HERDR_WEB_SESSION: session,
      HERDR_WEB_PORT: String(port),
      HERDR_WEB_ORIGINS: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [bridge.stdout, bridge.stderr])
    stream.on("data", (data) => {
      bridgeLog = (bridgeLog + String(data)).slice(-8000);
    });
  await until(
    async () => (await fetch(`${base}/healthz`)).ok,
    "bridge startup",
  );
  const rejected = connect(pane, "https://untrusted.example").ws;
  const [, response] = await once(rejected, "unexpected-response");
  assert.equal(response.statusCode, 403);
  rejected.terminate();
  for (let attachment = 0; attachment < 2; attachment++) {
    const client = connect(pane);
    await once(client.ws, "open");
    const mode = JSON.parse((await client.next()).data.toString());
    assert.equal(mode.mode, "watch");
    const meta = JSON.parse((await client.next()).data.toString());
    assert.equal(meta.type, "frame");
    assert.equal(meta.full, true);
    assert.equal(meta.cols, 120);
    const output = await client.next();
    assert.equal(output.binary, true);
    assert.match(output.data.toString(), /WATCH_STREAM_MARKER/);
    if (attachment === 0) {
      client.ws.send(
        JSON.stringify({
          type: "input",
          generation: meta.generation,
          text: "not allowed",
        }),
      );
      const error = JSON.parse((await client.next()).data.toString());
      assert.equal(error.type, "error");
    } else {
      client.ws.send(
        JSON.stringify({
          type: "ack",
          generation: meta.generation,
          seq: meta.seq,
        }),
      );
    }
    client.ws.close();
    await until(
      () => client.ws.readyState === WebSocket.CLOSED,
      "socket close",
    );
  }
  const a = connect(pane),
    b = connect(pane);
  await Promise.all([once(a.ws, "open"), once(b.ws, "open")]);
  await frame(a, "watch");
  await frame(b, "watch");
  command(a, { type: "control", takeover: false });
  await frame(a, "control");
  command(a, { type: "input", text: "printf 'CONTROL_%s\\n' DELIVERED\r" });
  for (let n = 0; n < 40; n++) {
    const output = await frame(a);
    if (output.output.includes(Buffer.from("CONTROL_DELIVERED"))) break;
    assert(n < 39, "terminal input was not executed");
  }
  command(a, { type: "resize", cols: 80, rows: 24 });
  for (let n = 0; n < 40; n++) {
    const resized = await frame(a);
    if (resized.meta.cols === 80 && resized.meta.rows === 24) break;
    assert(n < 39, "resize did not reach controller");
  }
  command(b, { type: "control", takeover: false });
  await frame(b, "watch");
  // Drain to the fresh watch attachment following the rejected control request.
  while (b.reason !== "control_busy") await frame(b, "watch");
  command(b, { type: "control", takeover: true });
  await frame(b, "control");
  await frame(a, "watch");
  command(b, { type: "release" });
  await frame(b, "watch");
  command(a, { type: "control", takeover: false });
  await frame(a, "control");
  a.ws.terminate();
  await until(
    () =>
      !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .some(
          (line) =>
            line.includes(session) && line.includes("terminal session control"),
        ),
    "controller cleanup",
  );
  command(b, { type: "control", takeover: false });
  await frame(b, "control");
  command(b, { type: "release" });
  await frame(b, "watch");
  b.ws.close();
  await until(
    () => b.ws.readyState === WebSocket.CLOSED,
    "controller socket close",
  );
  const after = cli("api", "snapshot").result.snapshot;
  assert.equal(after.focused_pane_id, before.focused_pane_id);
  assert.deepEqual(after.layouts, before.layouts);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator("#status").filter({ hasText: "read-only" }).waitFor();
  assert(await page.locator(".xterm-screen").isVisible());
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "WATCH_STREAM_MARKER" })
    .waitFor({ state: "attached" });
  cli("pane", "run", pane, "printf 'WATCH_STREAM_NEXT\\n'");
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "WATCH_STREAM_NEXT" })
    .waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page
    .locator("#mode-status")
    .filter({ hasText: "You control this pane" })
    .waitFor();
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("printf 'BROWSER_%s\\n' CONTROL_OK");
  await page.keyboard.press("Enter");
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "BROWSER_CONTROL_OK" })
    .waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Fit terminal", exact: true }).click();
  await until(
    () =>
      page.evaluate(
        () =>
          document.querySelector(".xterm-screen").getBoundingClientRect()
            .width <= document.querySelector("#viewport").clientWidth,
      ),
    "explicit control fit",
  );
  const second = cli(
    "tab",
    "create",
    "--workspace",
    created.result.workspace.workspace_id,
    "--cwd",
    process.cwd(),
    "--label",
    "Second",
    "--no-focus",
  ).result.root_pane.pane_id;
  await page.getByRole("button", { name: "Refresh panes" }).click();
  await until(
    async () => (await page.locator("#picker option").count()) === 2,
    "pane discovery",
  );
  assert.equal(await page.locator("#picker").inputValue(), pane);
  await page.getByRole("button", { name: "Next pane", exact: true }).click();
  await until(
    async () => (await page.locator("#picker").inputValue()) === second,
    "next pane",
  );
  await page.locator("#status").filter({ hasText: "read-only" }).waitFor();
  await until(
    () =>
      !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .some(
          (line) =>
            line.includes(session) && line.includes("terminal session control"),
        ),
    "control release on pane switch",
  );
  await page
    .locator("#terminal")
    .dispatchEvent("pointerdown", { pointerId: 1, clientX: 200, clientY: 20 });
  await page
    .locator("#terminal")
    .dispatchEvent("pointerup", { pointerId: 1, clientX: 20, clientY: 20 });
  assert.equal(await page.locator("#picker").inputValue(), second);
  await page
    .getByRole("button", { name: "Previous pane", exact: true })
    .click();
  await until(
    async () => (await page.locator("#picker").inputValue()) === pane,
    "previous pane",
  );
  await page.getByRole("button", { name: "Next pane", exact: true }).click();
  await until(
    async () => (await page.locator("#picker").inputValue()) === second,
    "next pane before swipe",
  );
  const label = await page.locator("#position").boundingBox();
  await page.mouse.move(label.x + 10, label.y + label.height / 2);
  await page.mouse.down();
  await page.mouse.move(label.x + 90, label.y + label.height / 2);
  await page.mouse.up();
  await until(
    async () => (await page.locator("#picker").inputValue()) === pane,
    "header swipe",
  );
  await page.getByRole("button", { name: "Next pane", exact: true }).click();
  await until(
    async () => (await page.locator("#picker").inputValue()) === second,
    "next pane before closure",
  );
  cli("pane", "close", second);
  await page.getByRole("button", { name: "Refresh panes" }).click();
  await until(
    async () => (await page.locator("#picker").inputValue()) === pane,
    "closed-pane fallback",
  );
  assert.equal(await page.locator(".xterm").count(), 1);
  assert.equal(
    cli("api", "snapshot").result.snapshot.focused_pane_id,
    before.focused_pane_id,
  );
  cli("pane", "run", pane, "printf 'PANE_FALLBACK_MARKER\\n'");
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "PANE_FALLBACK_MARKER" })
    .waitFor({ state: "attached" });
  await page.locator("summary").click();
  await page.locator("#pane").fill("w1:p999999");
  await page.getByRole("button", { name: "Watch", exact: true }).click();
  await until(
    async () =>
      !(await page.locator(".xterm-accessibility-tree").innerText()).includes(
        "PANE_FALLBACK_MARKER",
      ),
    "previous pane output cleared on failed switch",
  );
  assert.deepEqual(errors, []);
  await page.close();
  const blockedStorage = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  blockedStorage.on("pageerror", (error) => errors.push(error.message));
  await blockedStorage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    });
  });
  await blockedStorage.goto(base);
  await blockedStorage
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "PANE_FALLBACK_MARKER" })
    .waitFor({ state: "attached" });
  assert.deepEqual(errors, []);
  await blockedStorage.close();
  await until(() => {
    const processes = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    return !processes
      .split("\n")
      .some(
        (line) =>
          line.includes(session) && line.includes("terminal session observe"),
      );
  }, "observer cleanup");
  console.log(
    "PASS: real Herdr streaming, acquire/conflict/takeover/release, input/resize, scoped browser rendering/navigation, desktop non-interference and process cleanup",
  );
} finally {
  for (const socket of sockets) socket.terminate();
  if (browser) await browser.close();
  if (bridge) {
    try {
      process.kill(-bridge.pid, "SIGTERM");
    } catch {
      /* already exited */
    }
  }
  try {
    cli("server", "stop");
  } finally {
    server.kill("SIGTERM");
    try {
      execFileSync("herdr", ["session", "delete", session], {
        env,
        stdio: "ignore",
        timeout: 15000,
      });
    } catch {
      /* retain logs if shutdown failed */
    }
  }
}
