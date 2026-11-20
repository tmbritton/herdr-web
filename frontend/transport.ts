import { Context, Effect, Layer, Ref, Schema } from "effect";
import type { Scope } from "effect";
import * as Socket from "effect/socket/Socket";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { ClientCommand, PaneId } from "./domain.ts";
import { ClientJson, Snapshot, TransportError } from "./domain.ts";

export interface NativeSocket extends Socket.WebSocketLike {
  readonly bufferedAmount: number;
  binaryType: string;
}
export class SocketFactory extends Context.Service<
  SocketFactory,
  {
    readonly open: (url: string) => Effect.Effect<NativeSocket, TransportError>;
  }
>()("herdr-web/SocketFactory") {
  static readonly layer = Layer.succeed(SocketFactory, {
    open: (url) =>
      Effect.try({
        try: () => new WebSocket(url),
        catch: () =>
          new TransportError({
            operation: "connect",
            message: "Cannot open terminal connection",
          }),
      }),
  });
}
export interface Connection {
  readonly read: Effect.Effect<
    readonly (string | Uint8Array)[],
    TransportError
  >;
  readonly send: (
    command: ClientCommand,
  ) => Effect.Effect<void, TransportError>;
}
const encodeCommand = Schema.encodeEffect(ClientJson);
const encoder = new TextEncoder();
export const connect = Effect.fn("BridgeTransport.connect")(function* (
  origin: string,
  pane: PaneId,
): Effect.fn.Return<Connection, TransportError, SocketFactory | Scope.Scope> {
  const factory = yield* SocketFactory;
  const closed = yield* Ref.make(false);
  const url = yield* Effect.try({
    try: () => {
      const url = new URL(`/ws/${encodeURIComponent(pane)}`, origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
    catch: () =>
      new TransportError({
        operation: "connect",
        message: "Invalid bridge URL",
      }),
  });
  const native = yield* Effect.acquireRelease(factory.open(url), (socket) =>
    Ref.set(closed, true).pipe(
      Effect.andThen(Effect.sync(() => socket.close(1000))),
    ),
  );
  const socket = yield* Socket.fromWebSocket(Effect.succeed(native), {
    openTimeout: "8 seconds",
    highWaterMark: 1048576,
  });
  const reader = yield* socket.reader.pipe(
    Effect.mapError(
      () =>
        new TransportError({
          operation: "connect",
          message: "Terminal connection failed",
        }),
    ),
  );
  const writer = yield* socket.writer;
  const send = Effect.fn("BridgeTransport.send")(function* (
    command: ClientCommand,
  ) {
    const text = yield* encodeCommand(command).pipe(
      Effect.mapError(
        () =>
          new TransportError({
            operation: "write",
            message: "Invalid client command",
          }),
      ),
    );
    if ((yield* Ref.get(closed)) || native.readyState !== 1)
      return yield* new TransportError({
        operation: "write",
        message: "Connection closed; input was not replayed",
      });
    if (native.bufferedAmount + encoder.encode(text).byteLength > 65536)
      return yield* new TransportError({
        operation: "write",
        message: "Browser input buffer is full",
      });
    yield* writer.write(text).pipe(
      Effect.mapError(
        () =>
          new TransportError({
            operation: "write",
            message: "Input delivery is uncertain; input was not replayed",
          }),
      ),
      Effect.timeoutOrElse({
        duration: "500 millis",
        orElse: () =>
          Effect.fail(
            new TransportError({
              operation: "write",
              message: "Input delivery timed out; input was not replayed",
            }),
          ),
      }),
    );
  });
  const read = Effect.gen(function* () {
    if (yield* Ref.get(closed))
      return yield* new TransportError({
        operation: "read",
        message: "Connection closed",
      });
    return yield* reader.pull.pipe(
      Effect.mapError(
        () =>
          new TransportError({
            operation: "read",
            message: "Terminal connection ended",
          }),
      ),
    );
  });
  return { read, send };
});

export class BridgeOrigin extends Context.Service<
  BridgeOrigin,
  { readonly origin: string }
>()("herdr-web/BridgeOrigin") {}
export class BridgeTransport extends Context.Service<
  BridgeTransport,
  {
    readonly discover: Effect.Effect<Snapshot, TransportError>;
    readonly connect: (
      pane: PaneId,
    ) => Effect.Effect<Connection, TransportError, Scope.Scope>;
  }
>()("herdr-web/BridgeTransport") {
  static readonly layer = Layer.effect(
    BridgeTransport,
    Effect.gen(function* () {
      const { origin } = yield* BridgeOrigin;
      const factory = yield* SocketFactory;
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const discover = client.get(`${origin}/api/panes`).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Snapshot)),
        Effect.mapError(
          () =>
            new TransportError({
              operation: "discover",
              message: "Pane discovery unavailable or invalid",
            }),
        ),
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail(
              new TransportError({
                operation: "discover",
                message: "Pane discovery timed out",
              }),
            ),
        }),
      );
      return BridgeTransport.of({
        discover,
        connect: (pane) =>
          connect(origin, pane).pipe(
            Effect.provideService(SocketFactory, factory),
          ),
      });
    }),
  );
}
