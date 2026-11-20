import { Cause, Effect, Option, Queue, Schema, Stream } from "effect";
import { EventOverflow, Scroll, UiError } from "./domain.ts";
import type { ControlLease, View } from "./domain.ts";
import type { ScrollIntent } from "./machine.ts";

export type ScrollView = Extract<View, { readonly _tag: "Controlling" }>;
type Current = () => ScrollView | undefined;
export interface ScrollSample {
  readonly view: ScrollView;
  readonly steps: number;
  readonly column: number;
  readonly row: number;
  readonly time: number;
}
function sameView(a: ScrollView, b: ScrollView | undefined): boolean {
  return (
    b !== undefined &&
    a.lease.attachment === b.lease.attachment &&
    a.lease.generation === b.lease.generation &&
    a.cols === b.cols &&
    a.rows === b.rows
  );
}

// Gesture deltas are coalescible viewport movement, not text input. Keep a single
// bounded pending batch and recheck its lease/geometry after the scheduling delay.
export function coalescedScroll(
  current: Current,
  register: (
    push: (sample: ScrollSample) => void,
    clear: () => void,
  ) => () => void,
  onInteraction: (lease: ControlLease) => void = () => {},
): Stream.Stream<ScrollIntent, UiError | EventOverflow> {
  return Stream.callback<ScrollIntent, UiError | EventOverflow>(
    (output) =>
      Effect.gen(function* () {
        const wake = yield* Queue.sliding<undefined>(1);
        let pending: ScrollSample | undefined;
        const clear = () => {
          pending = undefined;
        };
        yield* Effect.addFinalizer(() =>
          Queue.shutdown(wake).pipe(Effect.asVoid),
        );
        yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              register((sample) => {
                if (
                  !Number.isFinite(sample.steps) ||
                  sample.steps === 0 ||
                  !Number.isInteger(sample.column) ||
                  !Number.isInteger(sample.row) ||
                  sample.column < 0 ||
                  sample.column >= sample.view.cols ||
                  sample.row < 0 ||
                  sample.row >= sample.view.rows ||
                  !sameView(sample.view, current())
                )
                  return;
                // Capture-time invalidation must beat a pending composer Enter;
                // waiting for the 32ms batch can otherwise send Enter first.
                onInteraction(sample.view.lease);
                const previous =
                  pending !== undefined &&
                  sameView(pending.view, sample.view) &&
                  sample.time - pending.time < 200
                    ? pending.steps
                    : 0;
                pending = {
                  ...sample,
                  steps: Math.max(-8, Math.min(8, previous + sample.steps)),
                };
                Queue.offerUnsafe(wake, undefined);
              }, clear),
            catch: () =>
              new UiError({ message: "Could not register terminal scrolling" }),
          }),
          (dispose) =>
            Effect.sync(() => {
              clear();
              dispose();
            }),
        );
        yield* Stream.fromQueue(wake).pipe(
          Stream.runForEach(() =>
            Effect.sleep("32 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  const sample = pending;
                  if (sample === undefined) return;
                  if (!sameView(sample.view, current())) {
                    clear();
                    return;
                  }
                  const steps = Math.trunc(sample.steps);
                  pending = { ...sample, steps: sample.steps - steps };
                  if (steps === 0) return;
                  const scroll = Schema.decodeUnknownOption(Scroll)({
                    direction: steps < 0 ? "up" : "down",
                    steps: Math.abs(steps),
                    column: sample.column,
                    row: sample.row,
                  });
                  if (Option.isNone(scroll)) return;
                  if (
                    !Queue.offerUnsafe(output, {
                      _tag: "Scroll",
                      lease: sample.view.lease,
                      scroll: scroll.value,
                    })
                  ) {
                    Queue.failCauseUnsafe(
                      output,
                      Cause.fail(new EventOverflow()),
                    );
                    Queue.shutdownUnsafe(output);
                  }
                }),
              ),
            ),
          ),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 16 },
  );
}

export function terminalScroll(
  viewport: HTMLElement,
  screen: HTMLElement,
  current: Current,
  selecting: () => boolean,
  onInteraction: (lease: ControlLease) => void,
): Stream.Stream<ScrollIntent, UiError | EventOverflow> {
  let suspended = document.hidden;
  const active: Current = () =>
    suspended || selecting() ? undefined : current();
  return coalescedScroll(
    active,
    (push, clear) => {
      suspended = document.hidden;
      const disposers: (() => void)[] = [];
      const listen = (
        target: EventTarget,
        name: string,
        fn: (event: Event) => void,
      ) => {
        target.addEventListener(name, fn, { capture: true, passive: false });
        disposers.push(() => target.removeEventListener(name, fn, true));
      };
      const cell = (view: ScrollView, x: number, y: number) => {
        const rect = screen.getBoundingClientRect();
        return {
          column: Math.max(
            0,
            Math.min(
              view.cols - 1,
              Math.floor(((x - rect.left) / rect.width) * view.cols),
            ),
          ),
          row: Math.max(
            0,
            Math.min(
              view.rows - 1,
              Math.floor(((y - rect.top) / rect.height) * view.rows),
            ),
          ),
        };
      };
      const move = (
        view: ScrollView,
        pixels: number,
        position: { column: number; row: number },
        time: number,
      ) => {
        // First expose any clipped rows of the current screen; at its edge, scroll
        // the application. This also works without changing the desktop geometry.
        const before = viewport.scrollTop;
        viewport.scrollTop = Math.max(
          0,
          Math.min(
            viewport.scrollHeight - viewport.clientHeight,
            before + pixels,
          ),
        );
        const remainder = pixels - (viewport.scrollTop - before);
        const stepHeight = Math.max(
          24,
          (screen.getBoundingClientRect().height / view.rows) * 3,
        );
        if (Math.abs(remainder) >= 0.5)
          push({ view, ...position, steps: remainder / stepHeight, time });
      };
      listen(viewport, "wheel", (event) => {
        if (!(event instanceof WheelEvent)) return;
        const view = active();
        if (
          view === undefined ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          !Number.isFinite(event.deltaY) ||
          Math.abs(event.deltaY) <= Math.abs(event.deltaX)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const lineHeight = screen.getBoundingClientRect().height / view.rows;
        const pixels =
          event.deltaY *
          (event.deltaMode === 1
            ? lineHeight
            : event.deltaMode === 2
              ? viewport.clientHeight
              : 1);
        move(
          view,
          pixels,
          cell(view, event.clientX, event.clientY),
          event.timeStamp,
        );
      });
      const touches = new Set<number>();
      let gesture:
        | {
            view: ScrollView;
            id: number;
            x: number;
            y: number;
            lastY: number;
            column: number;
            row: number;
            vertical: boolean;
          }
        | undefined;
      const cancel = () => {
        gesture = undefined;
        clear();
      };
      listen(window, "pointerdown", (event) => {
        if (!(event instanceof PointerEvent) || event.pointerType !== "touch")
          return;
        touches.add(event.pointerId);
        const view = active();
        if (touches.size !== 1 || !event.isPrimary) {
          cancel();
          return;
        }
        if (
          view === undefined ||
          selecting() ||
          !(event.target instanceof Node) ||
          !viewport.contains(event.target)
        )
          return;
        gesture = {
          view,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          lastY: event.clientY,
          ...cell(view, event.clientX, event.clientY),
          vertical: false,
        };
      });
      listen(viewport, "pointermove", (event) => {
        if (
          !(event instanceof PointerEvent) ||
          gesture === undefined ||
          event.pointerId !== gesture.id
        )
          return;
        if (!sameView(gesture.view, active()) || selecting()) {
          cancel();
          return;
        }
        const dx = Math.abs(event.clientX - gesture.x),
          dy = Math.abs(event.clientY - gesture.y);
        if (!gesture.vertical) {
          if (dx > 8 && dx >= dy) {
            gesture = undefined;
            return;
          }
          if (dy <= 8 || dy <= dx) return;
          gesture.vertical = true;
        }
        event.preventDefault();
        event.stopPropagation();
        move(
          gesture.view,
          gesture.lastY - event.clientY,
          gesture,
          event.timeStamp,
        );
        gesture.lastY = event.clientY;
      });
      const finish = (event: Event) => {
        if (!(event instanceof PointerEvent)) return;
        touches.delete(event.pointerId);
        if (gesture?.id === event.pointerId) gesture = undefined;
      };
      listen(window, "pointerup", finish);
      listen(window, "pointercancel", (event) => {
        finish(event);
        clear();
      });
      listen(viewport, "contextmenu", cancel);
      // xterm's document-level touch handler scrolls its local repaint buffer.
      // Keep it out of controlled gestures, while allowing native pan-x/zoom/taps.
      for (const name of ["touchstart", "touchmove", "touchend", "touchcancel"])
        listen(viewport, name, (event) => {
          if (active() === undefined || selecting()) return;
          event.stopPropagation();
          if (name === "touchmove" && gesture?.vertical && event.cancelable)
            event.preventDefault();
        });
      const visibility = (visible: boolean) => {
        suspended = !visible;
        cancel();
        touches.clear();
      };
      listen(document, "visibilitychange", () => visibility(!document.hidden));
      listen(window, "pagehide", () => visibility(false));
      listen(window, "pageshow", () => visibility(!document.hidden));
      return () => {
        cancel();
        for (const dispose of disposers.reverse()) dispose();
      };
    },
    onInteraction,
  );
}
