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
import { Dimensions, SubmissionId, UiError } from "./domain.ts";
import type {
  ControlLease,
  EventOverflow,
  Frame,
  FontSize,
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
      readonly ctrl?: boolean;
    }
  | {
      readonly _tag: "Key";
      readonly lease: ControlLease;
      readonly key: string;
      readonly ctrl: boolean;
    }
  | {
      readonly _tag: "Compose";
      readonly id: SubmissionId;
      readonly lease: ControlLease;
      readonly text: string;
      readonly style: string;
      readonly submit: boolean;
    }
  | { readonly _tag: "Font"; readonly value: number }
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
    readonly setFont: (size: FontSize) => Effect.Effect<void>;
    readonly composerActive: (id: SubmissionId) => Effect.Effect<boolean>;
    readonly finishComposer: (
      id: SubmissionId,
      message: string,
    ) => Effect.Effect<void>;
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
          reconnect: element("#reconnect", HTMLButtonElement),
          control: element("#control", HTMLButtonElement),
          takeover: element("#takeover", HTMLButtonElement),
          release: element("#release", HTMLButtonElement),
          fit: element("#fit", HTMLButtonElement),
          mode: element("#mode-status", HTMLElement),
          keyboard: element("#keyboard", HTMLButtonElement),
          ctrl: element("#ctrl", HTMLButtonElement),
          options: element("#options", HTMLDetailsElement),
          dialog: element("#pane-dialog", HTMLDialogElement),
          closePicker: element("#close-picker", HTMLButtonElement),
          font: element("#font-size", HTMLInputElement),
          fontValue: element("#font-value", HTMLOutputElement),
          composer: element("#composer", HTMLDetailsElement),
          compose: element("#compose", HTMLFormElement),
          prompt: element("#prompt", HTMLTextAreaElement),
          pasteStyle: element("#paste-style", HTMLSelectElement),
          paste: element("#paste", HTMLButtonElement),
          submit: element("#submit-prompt", HTMLButtonElement),
          clearPrompt: element("#clear-prompt", HTMLButtonElement),
          composerStatus: element("#composer-status", HTMLElement),
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
        (terminal) =>
          Effect.sync(() => {
            terminal.dispose();
            document.body.removeAttribute("data-control");
            for (const button of document.querySelectorAll("button"))
              button.disabled = true;
            dom.mode.textContent = "Disconnected";
            dom.status.textContent = "Session closed · reload to reconnect";
          }),
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
      const keyButtons = [
        ...document.querySelectorAll("button[data-key]"),
      ].filter(
        (button): button is HTMLButtonElement =>
          button instanceof HTMLButtonElement,
      );
      const drafts = new Map<string, { text: string; style: string }>();
      let knownPanes: readonly Pane[] = [];
      let draftKey = "";
      let draftPane: Option.Option<PaneId> = Option.none();
      let ctrlArmed = false;
      let nextSubmission = 0;
      let pending: Option.Option<{
        id: SubmissionId;
        key: string;
        cancelled: boolean;
      }> = Option.none();
      const setCtrl = (enabled: boolean) => {
        ctrlArmed = enabled;
        dom.ctrl.setAttribute("aria-pressed", String(enabled));
      };
      const activateDraft = (pane: PaneId) => {
        const terminalId = knownPanes.find(
          (item) => item.id === pane,
        )?.terminalId;
        const key =
          terminalId === undefined ? `pane:${pane}` : `terminal:${terminalId}`;
        if (key === draftKey) {
          draftPane = Option.some(pane);
          return;
        }
        const previous = {
          text: dom.prompt.value,
          style: dom.pasteStyle.value,
        };
        if (draftKey !== "") drafts.set(draftKey, previous);
        if (
          Option.isSome(draftPane) &&
          draftPane.value === pane &&
          draftKey.startsWith("pane:") &&
          !drafts.has(key)
        )
          drafts.set(key, previous);
        const next = drafts.get(key);
        dom.prompt.value = next?.text ?? "";
        dom.pasteStyle.value = next?.style ?? "bracketed";
        draftKey = key;
        draftPane = Option.some(pane);
      };
      const updateComposer = () => {
        const view = Ref.getUnsafe(visibleView);
        const enabled =
          Option.isSome(view) &&
          view.value._tag === "Controlling" &&
          Option.isNone(pending) &&
          dom.prompt.value.length > 0;
        dom.paste.disabled = !enabled;
        dom.submit.disabled = !enabled;
      };
      const showView = Effect.fnUntraced(function* (pane: PaneId, view: View) {
        yield* Ref.set(visibleView, Option.some(view));
        yield* Effect.sync(() => {
          const controlling = view._tag === "Controlling";
          activateDraft(pane);
          document.body.toggleAttribute("data-control", controlling);
          terminal.options.disableStdin = !controlling;
          dom.control.disabled = view._tag !== "Watching";
          dom.control.hidden =
            controlling || (view._tag === "Watching" && view.busy);
          dom.takeover.hidden = view._tag !== "Watching" || !view.busy;
          dom.takeover.disabled = view._tag !== "Watching";
          dom.release.disabled = !controlling;
          dom.release.hidden = !controlling;
          dom.fit.disabled = !controlling;
          dom.fit.hidden = !controlling;
          dom.keyboard.disabled = !controlling;
          dom.keyboard.hidden = !controlling;
          dom.ctrl.disabled = !controlling;
          for (const button of keyButtons) button.disabled = !controlling;
          if (!controlling) setCtrl(false);
          updateComposer();
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
              dom.mode.textContent = "Disconnected · last seen output";
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
          knownPanes = panes;
          if (id !== undefined) activateDraft(id);
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
            dom.control.hidden = false;
            dom.release.hidden = true;
            dom.fit.hidden = true;
            dom.keyboard.hidden = true;
            dom.ctrl.disabled = true;
            setCtrl(false);
            for (const button of keyButtons) button.disabled = true;
            document.body.removeAttribute("data-control");
            updateComposer();
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
          capture = false,
        ) => {
          target.addEventListener(name, listener, capture);
          disposers.push(() =>
            target.removeEventListener(name, listener, capture),
          );
        };
        let suppressPicker = false;
        listen(dom.position, "click", () => {
          if (suppressPicker) {
            suppressPicker = false;
            return;
          }
          if (!dom.dialog.open) dom.dialog.showModal();
        });
        listen(dom.closePicker, "click", () => dom.dialog.close());
        disposers.push(() => {
          if (dom.dialog.open) dom.dialog.close();
        });
        listen(dom.picker, "change", () => {
          emit({ _tag: "Select", value: dom.picker.value });
          dom.dialog.close();
        });
        listen(dom.attach, "submit", (event) => {
          event.preventDefault();
          emit({ _tag: "Select", value: dom.pane.value });
          dom.options.open = false;
        });
        listen(dom.previous, "click", () =>
          emit({ _tag: "Navigate", delta: -1 }),
        );
        listen(dom.next, "click", () => emit({ _tag: "Navigate", delta: 1 }));
        listen(dom.refresh, "click", () => emit({ _tag: "Refresh" }));
        listen(dom.reconnect, "click", () => emit({ _tag: "Reconnect" }));
        listen(dom.font, "input", () =>
          emit({ _tag: "Font", value: dom.font.valueAsNumber }),
        );
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
        listen(dom.keyboard, "click", () => terminal.focus());
        listen(dom.ctrl, "click", () =>
          withView((view) => {
            if (!suspended && view._tag === "Controlling") {
              setCtrl(!ctrlArmed);
              terminal.focus();
            }
          }),
        );
        for (const button of [...keyButtons, dom.ctrl]) {
          listen(button, "pointerdown", (event) => event.preventDefault());
        }
        for (const button of keyButtons)
          listen(button, "click", () =>
            withView((view) => {
              if (!suspended && view._tag === "Controlling") {
                emit({
                  _tag: "Key",
                  lease: view.lease,
                  key: button.getAttribute("data-key") ?? "",
                  ctrl: ctrlArmed,
                });
                setCtrl(false);
              }
            }),
          );
        const input = terminal.onData((text) =>
          withView((view) => {
            if (!suspended && view._tag === "Controlling") {
              emit({ _tag: "Input", lease: view.lease, text, ctrl: ctrlArmed });
              setCtrl(false);
            }
          }),
        );
        disposers.push(() => input.dispose());
        const submit = (text: string, enter: boolean) =>
          withView((view) => {
            if (
              suspended ||
              view._tag !== "Controlling" ||
              Option.isSome(pending)
            )
              return;
            const id = SubmissionId.make(++nextSubmission);
            pending = Option.some({ id, key: draftKey, cancelled: false });
            setCtrl(false);
            updateComposer();
            dom.composerStatus.textContent = "Sending…";
            emit({
              _tag: "Compose",
              id,
              lease: view.lease,
              text,
              style: dom.pasteStyle.value,
              submit: enter,
            });
          });
        listen(dom.prompt, "input", () => {
          drafts.set(draftKey, {
            text: dom.prompt.value,
            style: dom.pasteStyle.value,
          });
          updateComposer();
        });
        listen(dom.pasteStyle, "change", () =>
          drafts.set(draftKey, {
            text: dom.prompt.value,
            style: dom.pasteStyle.value,
          }),
        );
        listen(dom.paste, "click", () => submit(dom.prompt.value, false));
        listen(dom.compose, "submit", (event) => {
          event.preventDefault();
          submit(dom.prompt.value, true);
        });
        listen(dom.clearPrompt, "click", () => {
          dom.prompt.value = "";
          drafts.set(draftKey, { text: "", style: dom.pasteStyle.value });
          updateComposer();
        });
        listen(
          dom.terminal,
          "paste",
          (event) => {
            if (!(event instanceof ClipboardEvent)) return;
            event.preventDefault();
            event.stopPropagation();
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (text.length > 0) submit(text, false);
          },
          true,
        );
        const visibility = (visible: boolean) => {
          suspended = !visible;
          if (!visible) setCtrl(false);
          if (!visible && Option.isSome(pending))
            pending = Option.some({ ...pending.value, cancelled: true });
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
              event.target.closest("#previous, #next") !== null)
          )
            return;
          suppressPicker = false;
          gesture = Option.some({
            x: event.clientX,
            y: event.clientY,
            id: event.pointerId,
          });
          const target =
            event.target instanceof Element ? event.target : dom.nav;
          target.setPointerCapture(event.pointerId);
        });
        listen(dom.nav, "pointerup", (event) => {
          if (event instanceof PointerEvent && Option.isSome(gesture)) {
            const start = gesture.value;
            if (
              event.pointerId === start.id &&
              Math.abs(event.clientX - start.x) > 48 &&
              Math.abs(event.clientY - start.y) < 40
            ) {
              suppressPicker = true;
              emit({
                _tag: "Navigate",
                delta: event.clientX < start.x ? 1 : -1,
              });
            }
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
      let lastViewport = "";
      const resizes = Stream.callback<undefined>(
        (queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const emit = () => {
                Queue.offerUnsafe(queue, undefined);
              };
              const observer = new ResizeObserver(emit);
              observer.observe(dom.viewport);
              const viewport = window.visualViewport;
              viewport?.addEventListener("resize", emit);
              viewport?.addEventListener("scroll", emit);
              window.addEventListener("resize", emit);
              emit();
              return () => {
                observer.disconnect();
                viewport?.removeEventListener("resize", emit);
                viewport?.removeEventListener("scroll", emit);
                window.removeEventListener("resize", emit);
                document.documentElement.style.removeProperty("--app-height");
                document.documentElement.style.removeProperty("--app-top");
                document.body.removeAttribute("data-short");
              };
            }),
            (dispose) => Effect.sync(dispose),
          ),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(
        Stream.debounce("40 millis"),
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              const height = Math.max(
                1,
                Math.round(window.visualViewport?.height ?? window.innerHeight),
              );
              const top = Math.max(
                0,
                Math.round(window.visualViewport?.offsetTop ?? 0),
              );
              const key = `${height}:${top}`;
              if (lastViewport !== key) {
                lastViewport = key;
                document.documentElement.style.setProperty(
                  "--app-height",
                  `${height}px`,
                );
                document.documentElement.style.setProperty(
                  "--app-top",
                  `${top}px`,
                );
                document.body.toggleAttribute("data-short", height < 500);
              }
            });
            const view = yield* Ref.get(visibleView);
            return Option.isSome(view) && view.value._tag === "Controlling"
              ? Option.some<UiEvent>({
                  _tag: "Resize",
                  lease: view.value.lease,
                })
              : Option.none();
          }),
        ),
        Stream.filter(Option.isSome),
        Stream.map((value) => value.value),
      );
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
        setFont: (size) =>
          Effect.sync(() => {
            terminal.options.fontSize = size;
            dom.font.value = String(size);
            dom.fontValue.value = String(size);
          }),
        composerActive: (id) =>
          Effect.sync(
            () =>
              Option.isSome(pending) &&
              pending.value.id === id &&
              !pending.value.cancelled &&
              pending.value.key === draftKey,
          ),
        finishComposer: (id, message) =>
          Effect.sync(() => {
            if (Option.isNone(pending) || pending.value.id !== id) return;
            pending = Option.none();
            dom.composerStatus.textContent = message;
            updateComposer();
          }),
        notice: (message) =>
          Effect.sync(() => {
            dom.discovery.textContent = message;
          }),
      });
    }),
  );
}
