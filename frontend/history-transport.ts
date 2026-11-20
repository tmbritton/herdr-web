import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { PaneId } from "./domain.ts";
import { HistoryError, decodeHistoryPage } from "./history-domain.ts";
import type {
  HistoryPage,
  HistorySession,
  HistoryStart,
} from "./history-domain.ts";
import { BridgeOrigin } from "./transport.ts";

export class HistoryTransport extends Context.Service<
  HistoryTransport,
  {
    readonly load: (
      pane: PaneId,
      start: HistoryStart,
      session?: HistorySession,
    ) => Effect.Effect<HistoryPage, HistoryError>;
  }
>()("herdr-web/HistoryTransport") {
  static readonly layer = Layer.effect(
    HistoryTransport,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const { origin } = yield* BridgeOrigin;
      return HistoryTransport.of({
        load: (pane, start, session) =>
          Effect.gen(function* () {
            const query = new URLSearchParams({ start: String(start) });
            if (session !== undefined) query.set("session", session);
            const response = yield* client.get(
              `${origin}/api/history/${encodeURIComponent(pane)}?${query}`,
            );
            if (response.status !== 200) {
              const message = yield* response.text.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.String.check(Schema.isMaxLength(4096)),
                  ),
                ),
              );
              return yield* new HistoryError({ message });
            }
            const page = yield* HttpClientResponse.schemaBodyJson(
              Schema.Unknown,
            )(response).pipe(Effect.flatMap(decodeHistoryPage));
            if (session !== undefined && page.session !== session)
              return yield* new HistoryError({
                message:
                  "OpenCode session changed; reload History to follow it",
              });
            return page;
          }).pipe(
            Effect.mapError((error) =>
              error instanceof HistoryError
                ? error
                : new HistoryError({
                    message: "History unavailable or invalid",
                  }),
            ),
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () =>
                Effect.fail(
                  new HistoryError({
                    message: "History request timed out; try again",
                  }),
                ),
            }),
          ),
      });
    }),
  );
}
