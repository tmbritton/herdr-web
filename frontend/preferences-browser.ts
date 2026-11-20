import { Effect, Layer, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { PreferenceStore } from "./preferences.ts";

class StorageUnavailable extends Schema.TaggedError<StorageUnavailable>()(
  "StorageUnavailable",
  {},
) {}

// Accessing the property itself can throw before any store method exists.
// Capture it in the typed error channel before constructing the browser layer.
const storage = Layer.unwrap(
  Effect.try({
    try: () => globalThis.localStorage,
    catch: () => new StorageUnavailable(),
  }).pipe(
    Effect.match({
      onSuccess: (value) => KeyValueStore.layerStorage(() => value),
      onFailure: () => KeyValueStore.layerMemory,
    }),
  ),
);

export const browserPreferencesLayer = PreferenceStore.layer.pipe(
  Layer.provide(storage),
);
