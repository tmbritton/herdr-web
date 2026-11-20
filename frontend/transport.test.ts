import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { ClientCommand, PaneId } from "./domain.ts";
import { connect, SocketFactory, type NativeSocket } from "./transport.ts";

class FakeSocket extends EventTarget implements NativeSocket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  readonly sent: (string | Uint8Array)[] = [];
  closes = 0;
  close() {
    this.closes++;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
}

const fixture = Effect.gen(function* () {
  const pane = yield* Schema.decodeUnknownEffect(PaneId)("w1:p1");
  const command = yield* Schema.decodeUnknownEffect(ClientCommand)({
    type: "ack",
    generation: 1,
    seq: 1,
  });
  return { pane, command };
});

describe("scoped browser socket transport", () => {
  it.effect(
    "closes its connection on scope exit and never queues later writes",
    () =>
      Effect.gen(function* () {
        const socket = new FakeSocket();
        const { pane, command } = yield* fixture;
        const connection = yield* connect("http://localhost:3000", pane).pipe(
          Effect.provideService(SocketFactory, {
            open: () => Effect.succeed(socket),
          }),
          Effect.scoped,
        );
        assert.equal(socket.closes, 1);
        assert.isTrue(yield* Effect.isFailure(connection.send(command)));
        assert.equal(socket.sent.length, 0);
      }),
  );
  it.effect(
    "preserves text/binary message boundaries and bounds browser writes",
    () =>
      Effect.gen(function* () {
        const socket = new FakeSocket();
        const { pane, command } = yield* fixture;
        const connection = yield* connect("http://localhost:3000", pane).pipe(
          Effect.provideService(SocketFactory, {
            open: () => Effect.succeed(socket),
          }),
        );
        socket.dispatchEvent(new MessageEvent("message", { data: "metadata" }));
        socket.dispatchEvent(
          new MessageEvent("message", {
            data: new Uint8Array([27, 91]).buffer,
          }),
        );
        assert.deepEqual(yield* connection.read, [
          "metadata",
          new Uint8Array([27, 91]),
        ]);
        socket.bufferedAmount = 65536;
        assert.isTrue(yield* Effect.isFailure(connection.send(command)));
        assert.equal(socket.sent.length, 0);
      }),
  );
  it.effect("cancels an unopened connection using virtual time", () =>
    Effect.gen(function* () {
      const socket = new FakeSocket();
      socket.readyState = 0;
      const { pane } = yield* fixture;
      const fiber = yield* connect("http://localhost:3000", pane).pipe(
        Effect.provideService(SocketFactory, {
          open: () => Effect.succeed(socket),
        }),
        Effect.scoped,
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("9 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      assert.equal(socket.closes, 1);
    }),
  );
});
