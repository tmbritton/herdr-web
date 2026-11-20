import { once } from "node:events";

// Only use with an owned detached entrypoint that stays alive with its workers.
export async function stopDetached(
  child,
  { graceMs = 15000, killMs = 5000 } = {},
) {
  if (!child || child.pid === undefined) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  async function signalAndWait(signal, timeout) {
    if (exited()) return;
    const cancel = new AbortController();
    const exit = once(child, "exit", {
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(timeout)]),
    });
    try {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      await exit;
    } catch (error) {
      cancel.abort();
      await exit.catch(() => {});
      throw error;
    }
  }
  try {
    await signalAndWait("SIGTERM", graceMs);
  } catch (error) {
    if (error.code !== "ABORT_ERR") throw error;
    await signalAndWait("SIGKILL", killMs);
  }
}
