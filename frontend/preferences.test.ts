import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { KeyValueStore } from "effect/persistence";
import { PreferenceStore } from "./preferences.ts";
import { browserPreferencesLayer } from "./preferences-browser.ts";

it.effect("blocked browser storage cannot abort application startup", () =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previous = Object.getOwnPropertyDescriptor(
          globalThis,
          "localStorage",
        );
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get() {
            throw new DOMException("Blocked", "SecurityError");
          },
        });
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined)
            Reflect.deleteProperty(globalThis, "localStorage");
          else Object.defineProperty(globalThis, "localStorage", previous);
        }),
    );
    const result = yield* Effect.gen(function* () {
      const store = yield* PreferenceStore;
      return yield* store.load;
    }).pipe(Effect.provide(browserPreferencesLayer), Effect.exit);
    assert.isTrue(Exit.isSuccess(result));
    if (Exit.isSuccess(result)) assert.deepEqual(result.value, {});
  }),
);

const services = PreferenceStore.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory),
);
it.effect("migrates a validated selection from the previous frontend", () =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const preferences = yield* PreferenceStore;
    yield* store.set("herdr-pane", "w1:p2");
    yield* store.set("herdr-terminal", "term-stable");
    const saved = yield* preferences.load;
    assert.equal(saved.selection?.paneId, "w1:p2");
    assert.equal(saved.selection?.terminalId, "term-stable");
  }).pipe(Effect.provide(services)),
);
it.effect(
  "rejects malformed preferences and never restores control authority",
  () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const preferences = yield* PreferenceStore;
      yield* store.set("herdr-web.preferences", "not-json");
      assert.deepEqual(yield* preferences.load, {});
      yield* store.set(
        "herdr-web.preferences",
        '{"selection":{"paneId":"w1:p1"},"mode":"control"}',
      );
      assert.deepEqual<unknown>(yield* preferences.load, {
        selection: { paneId: "w1:p1" },
      });
    }).pipe(Effect.provide(services)),
);
