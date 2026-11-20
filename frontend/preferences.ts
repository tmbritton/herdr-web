import { Context, Effect, Layer, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Preferences } from "./domain.ts";

const Json = Schema.fromJsonString(Preferences);
const decode = Schema.decodeUnknownEffect(Json);
const encode = Schema.encodeEffect(Json);
const key = "herdr-web.preferences";

export class PreferenceStore extends Context.Service<
  PreferenceStore,
  {
    readonly load: Effect.Effect<Preferences>;
    readonly save: (preferences: Preferences) => Effect.Effect<void>;
  }
>()("herdr-web/PreferenceStore") {
  static readonly layer = Layer.effect(
    PreferenceStore,
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const load = Effect.gen(function* () {
        const value = yield* store.get(key);
        if (value !== undefined)
          return value.length <= 4096 ? yield* decode(value) : {};
        const paneId = yield* store.get("herdr-pane");
        if (paneId === undefined) return {};
        const terminalId = yield* store.get("herdr-terminal");
        return yield* Schema.decodeUnknownEffect(Preferences)({
          selection: {
            paneId,
            ...(terminalId === undefined ? {} : { terminalId }),
          },
        });
      }).pipe(Effect.catch(() => Effect.succeed({})));
      const save = Effect.fn("PreferenceStore.save")(
        (preferences: Preferences) =>
          encode(preferences).pipe(
            Effect.flatMap((value) => store.set(key, value)),
            Effect.catch(() => Effect.void),
          ),
      );
      return PreferenceStore.of({ load, save });
    }),
  );
}
