// Real Herdr integration against a unique disposable session; never user panes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { chromium } from "@playwright/test";
import { stopDetached } from "./process.mjs";

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
const readPane = (pane) =>
  execFileSync(
    "herdr",
    [
      "--session",
      session,
      "pane",
      "read",
      pane,
      "--source",
      "recent-unwrapped",
      "--lines",
      "80",
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
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
function startBridge() {
  const child = spawn("/bin/sh", ["./entrypoint.sh", "run"], {
    cwd: "build/erlang-shipment",
    detached: true,
    env: {
      ...env,
      HERDR_WEB_SESSION: session,
      HERDR_WEB_PORT: String(port),
      HERDR_WEB_ORIGINS: base,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      bridgeLog = (bridgeLog + String(data)).slice(-8000);
    });
  child.on("error", (error) => {
    bridgeLog += error.message;
  });
  return child;
}
async function until(fn, description, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
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
async function frame(client, desiredMode, acknowledge = true) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const message = await client.next();
    assert.equal(message.binary, false);
    const meta = JSON.parse(message.data.toString());
    if (meta.type === "pong") continue;
    if (meta.type === "mode") {
      client.mode = meta.mode;
      client.generation = meta.generation;
      if (meta.reason) client.reason = meta.reason;
      continue;
    }
    assert.equal(meta.type, "frame", JSON.stringify(meta));
    const output = await client.next();
    assert.equal(output.binary, true);
    const matches = !desiredMode || client.mode === desiredMode;
    if (acknowledge || !matches)
      client.ws.send(
        JSON.stringify({
          type: "ack",
          generation: meta.generation,
          seq: meta.seq,
        }),
      );
    if (matches) return { meta, output: output.data };
  }
  throw new Error(`Expected mode ${desiredMode}`);
}
function command(client, data) {
  client.ws.send(JSON.stringify({ ...data, generation: client.generation }));
}
async function options(page, open) {
  const currentlyOpen =
    (await page.locator("#options").getAttribute("open")) !== null;
  if (currentlyOpen !== open) await page.locator("#options > summary").click();
}
async function refreshPanes(page) {
  await options(page, true);
  await page
    .getByRole("button", { name: "Refresh panes", exact: true })
    .click();
  await options(page, false);
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
  cli("pane", "run", pane, "printf 'GEOMETRY_BEFORE_%s\\n' \"$(stty size)\"");
  await until(
    () => /GEOMETRY_BEFORE_(\d+) (\d+)/.test(readPane(pane)),
    "initial PTY geometry",
  );
  const geometryBefore = /GEOMETRY_BEFORE_(\d+) (\d+)/
    .exec(readPane(pane))
    .slice(1);
  const before = cli("api", "snapshot").result.snapshot;
  bridge = startBridge();
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
  cli("pane", "run", pane, "printf 'GEOMETRY_AFTER_%s\\n' \"$(stty size)\"");
  await until(
    () => /GEOMETRY_AFTER_(\d+) (\d+)/.test(readPane(pane)),
    "observer PTY geometry",
  );
  assert.deepEqual(
    /GEOMETRY_AFTER_(\d+) (\d+)/.exec(readPane(pane)).slice(1),
    geometryBefore,
  );
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
  const stalled = connect(pane);
  await once(stalled.ws, "open");
  await frame(stalled, "watch");
  command(stalled, { type: "control", takeover: false });
  await frame(stalled, "control", false);
  let stalledReason;
  stalled.ws.on("message", (bytes, binary) => {
    if (!binary) {
      const message = JSON.parse(bytes.toString());
      if (message.type === "error") stalledReason = message.reason;
    }
  });
  // A client can remain network-alive while its terminal renderer is frozen.
  const keepAlive = setInterval(() => {
    if (stalled.ws.readyState === WebSocket.OPEN)
      command(stalled, { type: "ping" });
  }, 2000);
  try {
    await until(
      () => stalled.ws.readyState === WebSocket.CLOSED,
      "stalled renderer deadline",
      150,
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(stalledReason, "render_timeout");
  await until(
    () =>
      !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .some(
          (line) =>
            line.includes(session) && line.includes("terminal session control"),
        ),
    "stalled controller release",
  );
  const fresh = connect(pane);
  await once(fresh.ws, "open");
  assert.equal((await frame(fresh, "watch")).meta.full, true);
  fresh.ws.close();
  const after = cli("api", "snapshot").result.snapshot;
  assert.equal(after.focused_pane_id, before.focused_pane_id);
  assert.deepEqual(after.layouts, before.layouts);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let connections = 0;
  page.on("websocket", () => {
    connections++;
  });
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
  await page.keyboard.type("printf 'TOUCH_%s\\n' ENTER_OK");
  await page.getByRole("button", { name: "Enter", exact: true }).tap();
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "TOUCH_ENTER_OK" })
    .waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Keyboard", exact: true }).click();
  await page.keyboard.type("THIS_SHOULD_NOT_RUN");
  await page.getByRole("button", { name: "Ctrl", exact: true }).tap();
  await page.keyboard.type("u");
  await page.keyboard.type("printf 'CTRL_%s\\n' LATCH_OK");
  await page.getByRole("button", { name: "Enter", exact: true }).tap();
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "CTRL_LATCH_OK" })
    .waitFor({ state: "attached" });
  cli("pane", "run", pane, "sleep 30");
  await sleep(200);
  await page.getByRole("button", { name: "Ctrl+C", exact: true }).tap();
  await sleep(200);
  cli("pane", "run", pane, "printf 'TOUCH_C_%s\\n' OK");
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "TOUCH_C_OK" })
    .waitFor({ state: "attached", timeout: 5000 });
  await page.locator("#composer > summary").click();
  const prompt =
    "printf 'COMPOSER_%s\\n' FIRST\nprintf 'COMPOSER_%s\\n' SECOND";
  await page.locator("#prompt").fill(prompt);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await page
    .locator("#composer-status")
    .filter({ hasText: "Sent to the control stream" })
    .waitFor();
  assert(
    !(await page.locator(".xterm-accessibility-tree").innerText()).includes(
      "COMPOSER_FIRST",
    ),
  );
  await page.getByRole("button", { name: "Enter", exact: true }).tap();
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "COMPOSER_SECOND" })
    .waitFor({ state: "attached" });
  assert.equal(await page.locator("#prompt").inputValue(), prompt);
  await page.locator("#prompt").fill("printf 'SUBMIT_%s\\n' OK");
  await page
    .getByRole("button", { name: "Paste + Enter", exact: true })
    .click();
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "SUBMIT_OK" })
    .waitFor({ state: "attached" });
  await page.locator("#paste-style").selectOption("plain");
  await page.locator("#prompt").fill("printf 'PLAIN_%s\\n' OK");
  await page
    .getByRole("button", { name: "Paste + Enter", exact: true })
    .click();
  await page
    .locator(".xterm-accessibility-tree")
    .filter({ hasText: "PLAIN_OK" })
    .waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Clear draft", exact: true }).click();
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.locator("#prompt").fill("keep this draft for the first terminal");
  await page.locator("#composer > summary").click();
  await options(page, true);
  await page.locator("#font-size").focus();
  await page.keyboard.press("Home");
  await until(
    async () => (await page.locator("#font-value").textContent()) === "10",
    "minimum font size",
  );
  for (let size = 11; size <= 18; size++) {
    await page.keyboard.press("ArrowRight");
    await until(
      async () =>
        (await page.locator("#font-value").textContent()) === String(size),
      "font size",
    );
  }
  await options(page, false);
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
  const beforeLayouts = connections;
  for (const [width, height] of [
    [884, 740],
    [844, 390],
    [640, 320],
    [360, 1000],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await until(
      () =>
        page.evaluate(
          ({ width, height }) => {
            const footer = document
              .querySelector("footer")
              .getBoundingClientRect();
            const terminal = document
              .querySelector("#viewport")
              .getBoundingClientRect();
            return (
              footer.bottom <= height + 1 &&
              footer.width <= width + 1 &&
              terminal.height > 20
            );
          },
          { width, height },
        ),
      "responsive viewport sizing",
    );
    assert.equal(await page.locator("#picker").inputValue(), pane);
    assert.equal(await page.locator(".xterm").count(), 1);
  }
  assert.equal(connections, beforeLayouts);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({ path: "test-results/phone.png" });
  await page.setViewportSize({ width: 390, height: 320 });
  await page.locator("#composer > summary").click();
  await page.locator("#prompt").fill("printf 'SHORT_%s\\n' COMPOSER_OK");
  await page
    .getByRole("button", { name: "Paste + Enter", exact: true })
    .click();
  try {
    await until(
      () => readPane(pane).includes("SHORT_COMPOSER_OK"),
      "short keyboard-height composer",
    );
  } catch (error) {
    console.log(
      "short composer",
      await page.locator("#composer-status").textContent(),
      await page.locator("#mode-status").textContent(),
      readPane(pane),
    );
    await page.screenshot({ path: "test-results/short-composer-failure.png" });
    throw error;
  }
  const enterKey = await page
    .getByRole("button", { name: "Enter", exact: true })
    .boundingBox();
  assert(enterKey.y >= 0 && enterKey.y + enterKey.height <= 321);
  await page.screenshot({ path: "test-results/short-composer.png" });
  await page.locator("#prompt").fill("keep this draft for the first terminal");
  await page.locator("#composer > summary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  // Wait for the controlled PTY to finish the resize before testing a reload.
  await until(
    () =>
      page
        .locator(".xterm-screen")
        .evaluate((element) => element.getBoundingClientRect().height > 200),
    "restored terminal height",
  );
  await page.reload();
  await page.locator("#status").filter({ hasText: "read-only" }).waitFor();
  assert.equal(await page.locator("#picker").inputValue(), pane);
  assert.equal(await page.locator("#font-value").textContent(), "18");
  await page.locator("#composer > summary").click();
  assert.equal(await page.locator("#prompt").inputValue(), "");
  await page.locator("#prompt").fill("keep this draft for the first terminal");
  await page.locator("#composer > summary").click();
  await page.getByRole("button", { name: "Take control", exact: true }).click();
  await page
    .locator("#mode-status")
    .filter({ hasText: "You control this pane" })
    .waitFor();
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
  await refreshPanes(page);
  await until(
    async () => (await page.locator("#picker option").count()) === 2,
    "pane discovery",
  );
  assert.equal(await page.locator("#picker").inputValue(), pane);
  await page
    .getByRole("button", { name: "Open pane picker", exact: true })
    .click();
  await page.locator("#pane-dialog").waitFor();
  await page.locator("#picker").selectOption(second);
  await until(
    async () => (await page.locator("#picker").inputValue()) === second,
    "next pane",
  );
  await page
    .locator("#status")
    .filter({ hasText: `Watching ${second}` })
    .waitFor();
  assert.equal(await page.locator("#prompt").inputValue(), "");
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
  assert.equal(
    await page.locator("#prompt").inputValue(),
    "keep this draft for the first terminal",
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
  await refreshPanes(page);
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
  await options(page, true);
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
  const restartController = connect(pane);
  await once(restartController.ws, "open");
  await frame(restartController, "watch");
  command(restartController, { type: "control", takeover: false });
  await frame(restartController, "control");
  cli(
    "pane",
    "run",
    pane,
    "HERDR_BRIDGE_PERSIST=alive; printf 'RESTART_%s\\n' ARMED",
  );
  await until(
    () => readPane(pane).includes("RESTART_ARMED"),
    "persistent workload setup",
  );
  const previousBridge = bridge;
  await stopDetached(previousBridge);
  bridge = undefined;
  await until(
    () => restartController.ws.readyState === WebSocket.CLOSED,
    "bridge shutdown disconnect",
  );
  await until(
    () =>
      !execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .some(
          (line) =>
            line.includes(session) && line.includes("terminal session control"),
        ),
    "bridge shutdown released control",
  );
  assert.equal(server.exitCode, null);
  assert.equal(
    cli("pane", "get", pane).result.pane.terminal_id,
    created.result.root_pane.terminal_id,
  );
  bridge = startBridge();
  await until(
    async () => (await fetch(`${base}/healthz`)).ok,
    "bridge restart",
  );
  const recovered = connect(pane);
  await once(recovered.ws, "open");
  assert.equal((await frame(recovered, "watch")).meta.full, true);
  recovered.ws.close();
  cli(
    "pane",
    "run",
    pane,
    "printf 'RESTART_STATE_%s\\n' \"$HERDR_BRIDGE_PERSIST\"",
  );
  await until(
    () => readPane(pane).includes("RESTART_STATE_alive"),
    "workload state survived bridge restart",
  );
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
    "PASS: real Herdr streaming/control/lifecycle, phone workflow, responsive layouts, desktop non-interference, process cleanup and workload survival across bridge restart",
  );
} finally {
  for (const socket of sockets) socket.terminate();
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await stopDetached(bridge);
    } finally {
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
  }
}
