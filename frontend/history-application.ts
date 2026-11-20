import { Context, Effect, Option, Ref, Schema, Stream } from "effect";
import type { EventOverflow, PaneId, UiError } from "./domain.ts";
import type { HistoryPage, HistoryStart } from "./history-domain.ts";
import { HistoryTransport } from "./history-transport.ts";

export const HistoryAction = Schema.Literals([
  "Beginning",
  "Older",
  "Newer",
  "Latest",
]);
export type HistoryAction = typeof HistoryAction.Type;
export class HistoryUi extends Context.Service<
  HistoryUi,
  {
    readonly pane: PaneId;
    readonly events: Stream.Stream<HistoryAction, UiError | EventOverflow>;
    readonly loading: Effect.Effect<void>;
    readonly show: (page: HistoryPage, atEnd: boolean) => Effect.Effect<void>;
    readonly error: (message: string) => Effect.Effect<void>;
  }
>()("herdr-web/HistoryUi") {}

export const runHistory = Effect.scoped(
  Effect.gen(function* () {
    const ui = yield* HistoryUi;
    const transport = yield* HistoryTransport;
    const current = yield* Ref.make<Option.Option<HistoryPage>>(Option.none());
    yield* Stream.concat(
      Stream.succeed<HistoryAction>("Latest"),
      ui.events,
    ).pipe(
      Stream.switchMap((action) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            const previous = Option.getOrUndefined(yield* Ref.get(current));
            const start: HistoryStart =
              action === "Latest"
                ? "latest"
                : action === "Beginning"
                  ? 0
                  : action === "Older"
                    ? Math.max(0, (previous?.start ?? 0) - 16)
                    : Math.min(
                        1000000000,
                        (previous?.start ?? 0) +
                          (previous?.entries.length ?? 0),
                      );
            yield* ui.loading;
            const page = yield* transport.load(
              ui.pane,
              start,
              previous?.session,
            );
            yield* Ref.set(current, Option.some(page));
            yield* ui.show(page, action === "Latest");
          }).pipe(Effect.catch((error) => ui.error(error.message))),
        ),
      ),
      Stream.runDrain,
    );
  }),
);
