import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { AttachmentId, InputText } from "./domain.ts";
import {
  authorize,
  complete,
  consume,
  initial,
  type Machine,
} from "./machine.ts";

const watch = '{"type":"mode","mode":"watch","generation":1,"reason":""}';
const full =
  '{"type":"frame","generation":1,"seq":1,"cols":80,"rows":24,"full":true}';
const begin = Effect.fnUntraced(function* () {
  const id = yield* Schema.decodeUnknownEffect(AttachmentId)(1);
  return (yield* consume(initial(id), watch)).machine;
});
const render = Effect.fnUntraced(function* (
  machine: Machine,
  header: string = full,
) {
  const pending = yield* consume(machine, header);
  const rendering = yield* consume(
    pending.machine,
    new Uint8Array([27, 91, 50, 74]),
  );
  assert.equal(rendering._tag, "Render");
  if (rendering._tag !== "Render")
    return yield* Effect.die("expected render transition");
  return rendering.machine;
});

describe("terminal protocol state and capabilities", () => {
  it.effect(
    "does not declare ready or acknowledge until rendering completes",
    () =>
      Effect.gen(function* () {
        const machine = yield* begin();
        const rendering = yield* render(machine);
        assert.equal(rendering.view._tag, "AwaitingSnapshot");
        const done = complete(rendering);
        assert.equal(done.machine.view._tag, "Watching");
        assert.deepEqual<unknown>(done.ack, {
          type: "ack",
          generation: 1,
          seq: 1,
        });
        assert.isTrue(yield* Effect.isFailure(consume(done.machine, full)));
        assert.isTrue(
          yield* Effect.isFailure(consume(done.machine, new Uint8Array([1]))),
        );
      }),
  );
  it.effect(
    "requires a full snapshot and rejects missing metadata or unsolicited control",
    () =>
      Effect.gen(function* () {
        const machine = yield* begin();
        assert.isTrue(
          yield* Effect.isFailure(
            consume(
              machine,
              '{"type":"frame","generation":1,"seq":1,"cols":80,"rows":24,"full":false}',
            ),
          ),
        );
        assert.isTrue(
          yield* Effect.isFailure(consume(machine, new Uint8Array([1]))),
        );
        assert.isTrue(
          yield* Effect.isFailure(
            consume(
              machine,
              '{"type":"mode","mode":"control","generation":2,"reason":""}',
            ),
          ),
        );
      }),
  );
  it.effect(
    "grants input only after explicit control and a new rendered snapshot",
    () =>
      Effect.gen(function* () {
        let machine = complete(yield* render(yield* begin())).machine;
        assert.equal(machine.view._tag, "Watching");
        if (machine.view._tag !== "Watching")
          return yield* Effect.die("expected watch capability");
        const requested = yield* authorize(machine, {
          _tag: "Control",
          lease: machine.view.lease,
          takeover: false,
        });
        assert.deepEqual<unknown>(requested.command, {
          type: "control",
          generation: 1,
          takeover: false,
        });
        machine = (yield* consume(
          requested.machine,
          '{"type":"mode","mode":"requesting-control","generation":2,"reason":""}',
        )).machine;
        machine = (yield* consume(
          machine,
          '{"type":"mode","mode":"control","generation":2,"reason":""}',
        )).machine;
        const rendering = yield* render(
          machine,
          '{"type":"frame","generation":2,"seq":1,"cols":80,"rows":24,"full":true}',
        );
        machine = complete(rendering).machine;
        assert.equal(machine.view._tag, "Controlling");
        if (machine.view._tag !== "Controlling")
          return yield* Effect.die("expected control capability");
        const lease = machine.view.lease;
        const text = yield* Schema.decodeUnknownEffect(InputText)("hello\r");
        assert.equal(
          (yield* authorize(machine, { _tag: "Input", lease, text })).command
            .type,
          "input",
        );
        const released = yield* authorize(machine, { _tag: "Release", lease });
        assert.isTrue(
          yield* Effect.isFailure(
            authorize(released.machine, { _tag: "Input", lease, text }),
          ),
        );
        const id = yield* Schema.decodeUnknownEffect(AttachmentId)(2);
        assert.isTrue(
          yield* Effect.isFailure(
            authorize(initial(id), { _tag: "Input", lease, text }),
          ),
        );
      }),
  );
});
