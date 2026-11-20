import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  ControlCols,
  Generation,
  InputText,
  PaneId,
  ServerRecord,
  Snapshot,
} from "./domain.ts";

describe("runtime domain boundaries", () => {
  it.effect("validates canonical pane identities before branding", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* Schema.decodeUnknownEffect(PaneId)("w19:p2"),
        "w19:p2",
      );
      for (const value of [
        "--takeover",
        "w01:p2",
        "w1:p0",
        "w1:p2;sh",
        "w1:p2/other",
        "w1:p2\n",
        null,
      ]) {
        assert.isTrue(
          yield* Effect.isFailure(Schema.decodeUnknownEffect(PaneId)(value)),
        );
      }
    }),
  );
  it.effect(
    "requires safe positive generations and bounded integral dimensions",
    () =>
      Effect.gen(function* () {
        for (const value of [
          0,
          -1,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          Number.MAX_SAFE_INTEGER + 1,
          "1",
        ]) {
          assert.isTrue(
            yield* Effect.isFailure(
              Schema.decodeUnknownEffect(Generation)(value),
            ),
          );
        }
        assert.equal(yield* Schema.decodeUnknownEffect(ControlCols)(80), 80);
        for (const value of [0, 401, 3.5])
          assert.isTrue(
            yield* Effect.isFailure(
              Schema.decodeUnknownEffect(ControlCols)(value),
            ),
          );
      }),
  );
  it.effect("bounds terminal input by UTF-8 bytes, not JS string length", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* Schema.decodeUnknownEffect(InputText)("hello\r"),
        "hello\r",
      );
      assert.isTrue(
        yield* Effect.isFailure(
          Schema.decodeUnknownEffect(InputText)("😀".repeat(5000)),
        ),
      );
      assert.isTrue(
        yield* Effect.isFailure(
          Schema.decodeUnknownEffect(InputText)("\ud800"),
        ),
      );
    }),
  );
  it.effect(
    "rejects malformed wire records and incoherent discovery snapshots",
    () =>
      Effect.gen(function* () {
        for (const value of [
          null,
          { type: "unknown" },
          { type: "mode", mode: "admin", generation: 1, reason: "" },
          {
            type: "frame",
            generation: 1,
            seq: 1,
            cols: 0,
            rows: 24,
            full: true,
          },
        ]) {
          assert.isTrue(
            yield* Effect.isFailure(
              Schema.decodeUnknownEffect(ServerRecord)(value),
            ),
          );
        }
        assert.isTrue(
          yield* Effect.isFailure(
            Schema.decodeUnknownEffect(Snapshot)({ result: { snapshot: {} } }),
          ),
        );
      }),
  );
  it.effect.prop(
    "accepts canonical numeric pane IDs",
    [
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
    ],
    ([workspace, pane]) =>
      Effect.gen(function* () {
        const value = `w${workspace}:p${pane}`;
        assert.equal(yield* Schema.decodeUnknownEffect(PaneId)(value), value);
      }),
  );
});
