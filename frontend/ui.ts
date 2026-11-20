import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Dimensions, UiError } from "./domain.ts";
import type {
  ControlLease,
  EventOverflow,
  Frame,
  Pane,
  PaneId,
  View,
  WatchLease,
} from "./domain.ts";
import { boundedEvents } from "./events.ts";
import { clearTerminal, writeTerminal } from "./terminal.ts";

export type UiEvent =
  | { readonly _tag: "Select"; readonly value: string }
  | { readonly _tag: "Navigate"; readonly delta: -1 | 1 }
  | { readonly _tag: "Refresh" }
  | { readonly _tag: "Reconnect" }
  | { readonly _tag: "Visibility"; readonly visible: boolean }
  | {
      readonly _tag: "Control";
      readonly lease: WatchLease;
      readonly takeover: boolean;
    }
  | { readonly _tag: "Release"; readonly lease: ControlLease }
  | {
      readonly _tag: "Input";
      readonly lease: ControlLease;
      readonly text: string;
    }
  | { readonly _tag: "Fit"; readonly lease: ControlLease }
  | { readonly _tag: "Resize"; readonly lease: ControlLease };

export class BrowserUi extends Context.Service<
  BrowserUi,
  {
    readonly visible: Effect.Effect<boolean>;
    readonly events: Stream.Stream<UiEvent, EventOverflow | UiError>;
    readonly clear: Effect.Effect<void, UiError>;
    readonly render: (
      frame: Frame,
      bytes: Uint8Array,
      reset: boolean,
    ) => Effect.Effect<void, UiError>;
    readonly showView: (pane: PaneId, view: View) => Effect.Effect<void>;
    readonly showPanes: (
      panes: readonly Pane[],
      selected: Option.Option<PaneId>,
    ) => Effect.Effect<void>;
    readonly notice: (message: string) => Effect.Effect<void>;
    readonly dimensions: Effect.Effect<Option.Option<Dimensions>, UiError>;
  }
>()("herdr-web/BrowserUi") {
  static readonly layer = Layer.effect(
    BrowserUi,
    Effect.gen(function* () {
      const element = <A extends Element>(
        selector: string,
        constructor: new () => A,
      ) =>
        Schema.decodeUnknownEffect(Schema.instanceOf(constructor))(
          document.querySelector(selector),
        ).pipe(
          Effect.mapError(
            () => new UiError({ message: `Missing UI element: ${selector}` }),
          ),
        );
      const dom = yield* Effect.all(
        {
          terminal: element("#terminal", HTMLElement),
          viewport: element("#viewport", HTMLElement),
          status: element("#status", HTMLElement),
          discovery: element("#discovery", HTMLElement),
          picker: element("#picker", HTMLSelectElement),
          pane: element("#pane", HTMLInputElement),
          attach: element("#attach", HTMLFormElement),
          previous: element("#previous", HTMLButtonElement),
          next: element("#next", HTMLButtonElement),
          position: element("#position", HTMLElement),
          nav: element("#pane-nav", HTMLElement),
          refresh: element("#refresh", HTMLButtonElement),
          control: element("#control", HTMLButtonElement),
          takeover: element("#takeover", HTMLButtonElement),
          release: element("#release", HTMLButtonElement),
          fit: element("#fit", HTMLButtonElement),
          mode: element("#mode-status", HTMLElement),
        },
        { concurrency: 1 },
      );
      const terminal = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Terminal({
              cols: 120,
              rows: 40,
              fontSize: 14,
              disableStdin: true,
              scrollback: 2000,
              screenReaderMode: true,
              theme: { background: "#10151c" },
            }),
        ),
        (terminal) => Effect.sync(() => terminal.dispose()),
      );
      const fit = new FitAddon();
      yield* Effect.try({
        try: () => {
          terminal.loadAddon(fit);
          terminal.open(dom.terminal);
        },
        catch: () =>
          new UiError({ message: "Could not initialize the terminal" }),
      });
      const visibleView = yield* Ref.make<Option.Option<View>>(Option.none());
      const showView = Effect.fnUntraced(function* (pane: PaneId, view: View) {
        yield* Ref.set(visibleView, Option.some(view));
        yield* Effect.sync(() => {
          const controlling = view._tag === "Controlling";
          terminal.options.disableStdin = !controlling;
          dom.control.disabled = view._tag !== "Watching";
          dom.takeover.hidden = view._tag !== "Watching" || !view.busy;
          dom.takeover.disabled = view._tag !== "Watching";
          dom.release.disabled = !controlling;
          dom.fit.disabled = !controlling;
          dom.pane.value = pane;
          switch (view._tag) {
            case "Connecting":
              dom.mode.textContent = "Watch mode";
              dom.status.textContent = `Connecting to ${pane}…`;
              break;
            case "AwaitingSnapshot":
              dom.mode.textContent =
                view.mode === "requesting-control"
                  ? "Requesting control…"
                  : "Waiting for fresh terminal view…";
              break;
            case "Watching":
              dom.mode.textContent = view.busy
                ? "Watch mode · another controller is active"
                : "Watch mode";
              dom.status.textContent = `Watching ${pane} · read-only`;
              break;
            case "Controlling":
              dom.mode.textContent = "You control this pane";
              dom.status.textContent = `Controlling ${pane}`;
              break;
            case "Disconnected":
              dom.mode.textContent = "Watch mode";
              dom.status.textContent = `${pane}: ${view.message}`;
              break;
          }
        });
      });
      const showPanes = Effect.fnUntraced(function* (
        panes: readonly Pane[],
        selected: Option.Option<PaneId>,
      ) {
        if (Option.isNone(selected)) yield* Ref.set(visibleView, Option.none());
        yield* Effect.sync(() => {
          const id = Option.getOrUndefined(selected);
          const active = panes.find((p) => p.id === id);
          const index = panes.findIndex((p) => p.id === id);
          const siblings = panes.filter((p) => p.tabId === active?.tabId);
          dom.position.textContent =
            active === undefined
              ? "No pane selected"
              : `${active.group} · ${active.label} · ${siblings.findIndex((p) => p.id === id) + 1}/${siblings.length}`;
          dom.previous.disabled = index <= 0;
          dom.next.disabled = index < 0 || index >= panes.length - 1;
          dom.picker.replaceChildren();
          const groups = new Map<string, HTMLOptGroupElement>();
          for (const pane of panes) {
            let group = groups.get(pane.tabId);
            if (group === undefined) {
              group = document.createElement("optgroup");
              group.label = pane.group;
              groups.set(pane.tabId, group);
              dom.picker.append(group);
            }
            const option = document.createElement("option");
            option.value = pane.id;
            option.textContent = pane.label;
            group.append(option);
          }
          dom.picker.value = id ?? "";
          if (Option.isNone(selected)) {
            terminal.options.disableStdin = true;
            dom.control.disabled = true;
            dom.release.disabled = true;
            dom.fit.disabled = true;
            dom.takeover.hidden = true;
            dom.mode.textContent = "Watch mode";
            dom.status.textContent = "No terminal panes are available";
          }
        });
      });
      const withView = (fn: (view: View) => void) =>
        Option.match(Ref.getUnsafe(visibleView), {
          onNone: () => {},
          onSome: fn,
        });
      const events = boundedEvents<UiEvent>((emit) => {
        const disposers: (() => void)[] = [];
        let suspended = document.hidden;
        const listen = (
          target: EventTarget,
          name: string,
          listener: (event: Event) => void,
        ) => {
          target.addEventListener(name, listener);
          disposers.push(() => target.removeEventListener(name, listener));
        };
        listen(dom.picker, "change", () =>
          emit({ _tag: "Select", value: dom.picker.value }),
        );
        listen(dom.attach, "submit", (event) => {
          event.preventDefault();
          emit({ _tag: "Select", value: dom.pane.value });
        });
        listen(dom.previous, "click", () =>
          emit({ _tag: "Navigate", delta: -1 }),
        );
        listen(dom.next, "click", () => emit({ _tag: "Navigate", delta: 1 }));
        listen(dom.refresh, "click", () => emit({ _tag: "Refresh" }));
        for (const [button, takeover] of [
          [dom.control, false],
          [dom.takeover, true],
        ] as const)
          listen(button, "click", () =>
            withView((view) => {
              if (!suspended && view._tag === "Watching")
                emit({ _tag: "Control", lease: view.lease, takeover });
            }),
          );
        listen(dom.release, "click", () =>
          withView((view) => {
            if (view._tag === "Controlling")
              emit({ _tag: "Release", lease: view.lease });
          }),
        );
        listen(dom.fit, "click", () =>
          withView((view) => {
            if (!suspended && view._tag === "Controlling")
              emit({ _tag: "Fit", lease: view.lease });
          }),
        );
        const input = terminal.onData((text) =>
          withView((view) => {
            if (!suspended && view._tag === "Controlling")
              emit({ _tag: "Input", lease: view.lease, text });
          }),
        );
        disposers.push(() => input.dispose());
        const visibility = (visible: boolean) => {
          suspended = !visible;
          emit({ _tag: "Visibility", visible });
        };
        listen(document, "visibilitychange", () =>
          visibility(!document.hidden),
        );
        listen(window, "pagehide", () => visibility(false));
        listen(window, "pageshow", () => visibility(!document.hidden));
        let gesture: Option.Option<{
          readonly x: number;
          readonly y: number;
          readonly id: number;
        }> = Option.none();
        listen(dom.nav, "pointerdown", (event) => {
          if (
            !(event instanceof PointerEvent) ||
            (event.target instanceof Element &&
              event.target.closest("button") !== null)
          )
            return;
          gesture = Option.some({
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId,
          });
          dom.nav.setPointerCapture(event.pointerId);
        });
        listen(dom.nav, "pointerup", (event) => {
          if (event instanceof PointerEvent && Option.isSome(gesture)) {
            const start = gesture.value;
            if (
              event.pointerId === start.id &&
              Math.abs(event.clientX - start.x) > 48 &&
              Math.abs(event.clientY - start.y) < 40
            )
              emit({
                _tag: "Navigate",
                delta: event.clientX < start.x ? 1 : -1,
              });
          }
          gesture = Option.none();
        });
        listen(dom.nav, "pointercancel", () => {
          gesture = Option.none();
        });
        return () => {
          for (const dispose of disposers.reverse()) dispose();
        };
      });
      const resizes = Stream.callback<UiEvent>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const observer = new ResizeObserver(() =>
                withView((view) => {
                  if (view._tag === "Controlling")
                    Queue.offerUnsafe(queue, {
                      _tag: "Resize",
                      lease: view.lease,
                    });
                }),
              );
              observer.observe(dom.viewport);
              return observer;
            }),
            (observer) => Effect.sync(() => observer.disconnect()),
          ),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(Stream.debounce("60 millis"));
      const dimensions = Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = {
            width: dom.terminal.style.width,
            height: dom.terminal.style.height,
          };
          const style = getComputedStyle(dom.viewport);
          const pixels = (value: string) => {
            const n = Number.parseFloat(value);
            return Number.isFinite(n) ? n : 0;
          };
          dom.terminal.style.width = `${Math.max(0, dom.viewport.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight))}px`;
          dom.terminal.style.height = `${Math.max(0, dom.viewport.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom))}px`;
          return previous;
        }),
        () =>
          Effect.try({
            try: () => fit.proposeDimensions(),
            catch: () => new UiError({ message: "Could not measure terminal" }),
          }),
        (previous) =>
          Effect.sync(() => {
            dom.terminal.style.width = previous.width;
            dom.terminal.style.height = previous.height;
          }),
      ).pipe(
        Effect.flatMap((size) =>
          size === undefined
            ? Effect.succeedNone
            : Schema.decodeUnknownEffect(Dimensions)({
                cols: Math.min(400, size.cols),
                rows: Math.min(200, size.rows),
              }).pipe(Effect.option),
        ),
      );
      return BrowserUi.of({
        visible: Effect.sync(() => !document.hidden),
        events: Stream.merge(events, resizes),
        clear: clearTerminal(terminal),
        render: (frame, bytes, reset) =>
          writeTerminal(terminal, frame, bytes, reset),
        showView,
        showPanes,
        dimensions,
        notice: (message) =>
          Effect.sync(() => {
            dom.discovery.textContent = message;
          }),
      });
    }),
  );
}
