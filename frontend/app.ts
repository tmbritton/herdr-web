import { BrowserHttpClient, BrowserRuntime } from "@effect/platform-browser";
import { Effect, Layer } from "effect";
import { runApplication } from "./application.ts";
import { browserPreferencesLayer } from "./preferences-browser.ts";
import { BridgeOrigin, BridgeTransport, SocketFactory } from "./transport.ts";
import { BrowserUi } from "./ui.ts";
import "./style.css";

const transport = BridgeTransport.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      BrowserHttpClient.layerFetch,
      SocketFactory.layer,
      Layer.succeed(BridgeOrigin, { origin: window.location.origin }),
    ),
  ),
);
BrowserRuntime.runMain(
  runApplication.pipe(
    Effect.provide([BrowserUi.layer, transport, browserPreferencesLayer]),
  ),
);
