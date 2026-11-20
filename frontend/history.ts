import { BrowserHttpClient, BrowserRuntime } from "@effect/platform-browser";
import { Effect, Layer, Option, Schema } from "effect";
import { PaneId, UiError } from "./domain.ts";
import { boundedEvents } from "./events.ts";
import { HistoryAction, HistoryUi, runHistory } from "./history-application.ts";
import { HistoryTransport } from "./history-transport.ts";
import { BridgeOrigin } from "./transport.ts";
import "./history.css";

const uiLayer = Layer.effect(
  HistoryUi,
  Effect.gen(function* () {
    const pane = yield* Effect.try({
      try: () =>
        decodeURIComponent(window.location.pathname.split("/")[2] ?? ""),
      catch: () => new UiError({ message: "Invalid history URL" }),
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PaneId)));
    const element = (id: string) =>
      Schema.decodeUnknownEffect(Schema.instanceOf(HTMLElement))(
        document.getElementById(id),
      );
    const dom = yield* Effect.all({
      title: element("history-title"),
      status: element("history-status"),
      transcript: element("transcript"),
    });
    const buttons = [
      ...document.querySelectorAll("button[data-action]"),
    ].filter(
      (button): button is HTMLButtonElement =>
        button instanceof HTMLButtonElement,
    );
    const events = boundedEvents<HistoryAction>((emit) => {
      const disposers: (() => void)[] = [];
      for (const button of buttons) {
        const action = Schema.decodeUnknownOption(HistoryAction)(
          button.dataset["action"],
        );
        if (Option.isNone(action)) continue;
        const click = () => emit(action.value);
        button.addEventListener("click", click);
        disposers.push(() => button.removeEventListener("click", click));
      }
      return () => {
        for (const dispose of disposers) dispose();
      };
    });
    return HistoryUi.of({
      pane,
      events,
      loading: Effect.sync(() => {
        dom.status.textContent = "Loading history…";
      }),
      error: (message) =>
        Effect.sync(() => {
          dom.status.textContent = message;
        }),
      show: (page, atEnd) =>
        Effect.sync(() => {
          dom.title.textContent = `${page.title} · ${pane}`;
          dom.status.textContent =
            page.total === 0
              ? "No transcript text yet"
              : `Read-only · segments ${page.start + 1}–${page.start + page.entries.length} of ${page.total} · Latest refreshes`;
          const entries = page.entries.map((entry) => {
            const article = document.createElement("article");
            const heading = document.createElement("h2");
            heading.textContent = `${entry.role} · ${entry.kind}${entry.offset > 0 ? " · continued" : ""}`;
            const text = document.createElement("pre");
            text.textContent = entry.text;
            article.append(heading, text);
            return article;
          });
          dom.transcript.replaceChildren(...entries);
          dom.transcript.scrollTop = atEnd ? dom.transcript.scrollHeight : 0;
          for (const button of buttons) {
            button.disabled =
              button.dataset["action"] === "Older" ||
              button.dataset["action"] === "Beginning"
                ? page.start === 0
                : button.dataset["action"] === "Newer" &&
                  page.start + page.entries.length >= page.total;
          }
        }),
    });
  }),
);
const transport = HistoryTransport.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      BrowserHttpClient.layerFetch,
      Layer.succeed(BridgeOrigin, { origin: window.location.origin }),
    ),
  ),
);
BrowserRuntime.runMain(runHistory.pipe(Effect.provide([uiLayer, transport])));
