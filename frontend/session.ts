import { Deferred, Effect, Option, Ref, Semaphore } from "effect";
import type {
  AttachmentId,
  PaneId,
  TransportError,
  UiError,
  View,
} from "./domain.ts";
import { CommandRejected, ProtocolError } from "./domain.ts";
import { authorize, complete, consume, initial } from "./machine.ts";
import type { Intent } from "./machine.ts";
import { BrowserUi } from "./ui.ts";
import { BridgeTransport } from "./transport.ts";
import type { Connection } from "./transport.ts";

export interface Attachment {
  readonly view: Effect.Effect<View>;
  readonly run: Effect.Effect<void, ProtocolError | TransportError | UiError>;
  readonly send: (
    intent: Intent,
  ) => Effect.Effect<void, CommandRejected | TransportError>;
}
export const makeAttachment = Effect.fn("makeAttachment")(function* (
  id: AttachmentId,
  pane: PaneId,
  publish: (view: View) => Effect.Effect<void>,
): Effect.fn.Return<Attachment, never, BrowserUi | BridgeTransport> {
  const ui = yield* BrowserUi;
  const transport = yield* BridgeTransport;
  const state = yield* Ref.make(initial(id));
  const connection = yield* Ref.make<Option.Option<Connection>>(Option.none());
  const started = yield* Ref.make(false);
  const failedWrite = yield* Deferred.make<never, TransportError>();
  const lock = yield* Semaphore.make(1);
  const send = Effect.fn("Attachment.send")(function* (intent: Intent) {
    const outbound = yield* Effect.gen(function* () {
      const writer = yield* Ref.get(connection);
      if (Option.isNone(writer))
        return yield* new CommandRejected({
          message: "No live attachment; input was not queued",
        });
      const current = yield* Ref.get(state);
      const next = yield* authorize(current, intent);
      yield* Ref.set(state, next.machine);
      return { writer: writer.value, command: next.command };
    }).pipe(Semaphore.withPermits(lock, 1));
    yield* outbound.writer
      .send(outbound.command)
      .pipe(Effect.tapError((error) => Deferred.fail(failedWrite, error)));
  });
  const run = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true))
      return yield* new ProtocolError({
        message: "An attachment cannot be reused after reconnect",
      });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* publish(initial(id).view);
        yield* ui.clear;
        const socket = yield* transport.connect(pane);
        yield* Ref.set(connection, Option.some(socket));
        yield* Effect.addFinalizer(() => Ref.set(connection, Option.none()));
        const consumeBatch = Effect.gen(function* () {
          const packets = yield* socket.read;
          for (const packet of packets) {
            const update = yield* Effect.gen(function* () {
              const before = yield* Ref.get(state);
              const transition = yield* consume(before, packet);
              yield* Ref.set(state, transition.machine);
              return { transition, previousView: before.view };
            }).pipe(Semaphore.withPermits(lock, 1));
            const { transition } = update;
            if (transition._tag === "Updated") {
              if (transition.machine.view !== update.previousView)
                yield* publish(transition.machine.view);
              continue;
            }
            yield* ui.render(
              transition.machine.frame,
              transition.bytes,
              Option.isNone(transition.machine.last),
            );
            const done = yield* Effect.gen(function* () {
              const latest = yield* Ref.get(state);
              if (latest._tag !== "Rendering")
                return yield* new ProtocolError({
                  message: "Rendering state changed unexpectedly",
                });
              const done = complete(latest);
              yield* Ref.set(state, done.machine);
              return done;
            }).pipe(Semaphore.withPermits(lock, 1));
            yield* publish(done.machine.view);
            yield* socket.send(done.ack);
          }
        });
        return yield* Effect.raceFirst(
          Effect.forever(consumeBatch),
          Deferred.await(failedWrite),
        );
      }),
    );
  });
  return {
    run,
    send,
    view: Ref.get(state).pipe(Effect.map((machine) => machine.view)),
  };
});
