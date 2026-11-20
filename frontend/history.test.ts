import { assert, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Queue, Schema, Stream } from "effect";
import { PaneId } from "./domain.ts";
import { HistoryUi, runHistory } from "./history-application.ts";
import type { HistoryAction } from "./history-application.ts";
import { HistoryPage, decodeHistoryPage } from "./history-domain.ts";
import type { HistorySession, HistoryStart } from "./history-domain.ts";
import { HistoryTransport } from "./history-transport.ts";

it.effect(
  "preserves NUL, literal escapes, BOMs and Unicode split across history pages",
  () =>
    Effect.gen(function* () {
      for (const padding of [4093, 4094, 4095, 4096]) {
        const text = "a".repeat(padding) + "🙂\u0000AFTER_NUL\\u0000\ufeffend";
        const bytes = Buffer.from(text);
        let rendered = "";
        for (let offset = 0; offset < bytes.length; offset += 4096) {
          const page = yield* decodeHistoryPage({
            session: "ses_fixture",
            title: "Fixture",
            start: 0,
            total: 1,
            entries: [
              {
                message: "msg_1",
                role: "assistant",
                kind: "text",
                offset,
                bytes: bytes
                  .subarray(offset, offset + 4099)
                  .toString("hex")
                  .toUpperCase(),
              },
            ],
          });
          rendered += page.entries.map((entry) => entry.text).join("");
        }
        assert.equal(rendered, text);
      }
      assert.isTrue(
        yield* Effect.isFailure(
          decodeHistoryPage({
            session: "ses_fixture",
            title: "Fixture",
            start: 0,
            total: 1,
            entries: [
              {
                message: "msg_1",
                role: "user",
                kind: "text",
                offset: 0,
                bytes: "FF",
              },
            ],
          }),
        ),
      );
    }),
);

it.effect(
  "cancels obsolete history requests, pins session identity, and closes pending work",
  () =>
    Effect.gen(function* () {
      const pane = yield* Schema.decodeUnknownEffect(PaneId)("w1:p1");
      const page = yield* Schema.decodeUnknownEffect(HistoryPage)({
        session: "ses_fixture",
        title: "Fixture",
        start: 16,
        total: 32,
        entries: Array.from({ length: 16 }, (_, i) => ({
          message: `msg_${i}`,
          role: "user",
          kind: "text",
          offset: 0,
          text: `Message ${i}`,
        })),
      });
      const events = yield* Queue.make<HistoryAction>();
      const calls = yield* Queue.make<{
        start: HistoryStart;
        session: HistorySession | undefined;
      }>();
      const shown = yield* Queue.make<HistoryPage>();
      let cancelled = 0;
      const fiber = yield* runHistory.pipe(
        Effect.provideService(HistoryUi, {
          pane,
          events: Stream.fromQueue(events),
          loading: Effect.void,
          error: (message) => Effect.die(new Error(message)),
          show: (page) => Queue.offer(shown, page).pipe(Effect.asVoid),
        }),
        Effect.provideService(HistoryTransport, {
          load: (_pane, start, session) =>
            Effect.gen(function* () {
              yield* Queue.offer(calls, { start, session });
              if (start === 0)
                return yield* Effect.never.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      if (Exit.hasInterrupts(exit)) cancelled++;
                    }),
                  ),
                );
              return page;
            }),
        }),
        Effect.forkChild,
      );
      assert.deepEqual(yield* Queue.take(calls), {
        start: "latest",
        session: undefined,
      });
      yield* Queue.take(shown);
      yield* Queue.offer(events, "Beginning");
      assert.deepEqual(yield* Queue.take(calls), {
        start: 0,
        session: page.session,
      });
      yield* Queue.offer(events, "Latest");
      assert.deepEqual(yield* Queue.take(calls), {
        start: "latest",
        session: page.session,
      });
      yield* Queue.take(shown);
      assert.equal(cancelled, 1);
      yield* Queue.offer(events, "Beginning");
      yield* Queue.take(calls);
      yield* Fiber.interrupt(fiber);
      assert.equal(cancelled, 2);
    }),
);

it.effect("rejects incomplete or oversized transcript pages", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(HistoryPage);
    const empty = {
      session: "ses_fixture",
      title: "Fixture",
      start: 0,
      total: 0,
      entries: [],
    };
    yield* decode(empty);
    assert.isTrue(yield* Effect.isFailure(decode({ ...empty, total: 10 })));
    assert.isTrue(yield* Effect.isFailure(decode({ ...empty, start: 1 })));
    assert.isTrue(
      yield* Effect.isFailure(
        decode({
          ...empty,
          total: 1,
          entries: [
            {
              message: "msg_1",
              role: "user",
              kind: "text",
              offset: 0,
              text: "x".repeat(8193),
            },
          ],
        }),
      ),
    );
  }),
);
