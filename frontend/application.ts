import {
  Effect,
  Fiber,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { AttachmentId, InputText, PaneId, UiError } from "./domain.ts";
import type {
  ControlLease,
  Dimensions,
  Pane,
  Selection,
  Snapshot,
} from "./domain.ts";
import { normalize, selectPane, selectionOf } from "./navigation.ts";
import { PreferenceStore } from "./preferences.ts";
import { makeAttachment } from "./session.ts";
import type { Attachment } from "./session.ts";
import { BridgeTransport } from "./transport.ts";
import { BrowserUi } from "./ui.ts";
import type { UiEvent } from "./ui.ts";
import type { Intent } from "./machine.ts";

type AppEvent =
  | UiEvent
  | { readonly _tag: "Tick" }
  | {
      readonly _tag: "Snapshot";
      readonly epoch: number;
      readonly snapshot: Snapshot;
    }
  | {
      readonly _tag: "DiscoveryFailed";
      readonly epoch: number;
      readonly message: string;
    }
  | {
      readonly _tag: "SessionView";
      readonly id: AttachmentId;
    }
  | {
      readonly _tag: "SessionEnded";
      readonly id: AttachmentId;
      readonly message: string;
    };
type Active = {
  readonly id: AttachmentId;
  readonly pane: PaneId;
  readonly attachment: Attachment;
  readonly fiber: Fiber.Fiber<void>;
  readonly autoFit: Option.Option<ControlLease>;
  readonly size: Option.Option<Dimensions>;
};

export const runApplication = Effect.scoped(
  Effect.gen(function* () {
    const ui = yield* BrowserUi;
    const transport = yield* BridgeTransport;
    const preferences = yield* PreferenceStore;
    const saved = yield* preferences.load;
    const selection = yield* Ref.make<Option.Option<Selection>>(
      Option.fromUndefinedOr(saved.selection),
    );
    const panes = yield* Ref.make<readonly Pane[]>([]);
    const active = yield* Ref.make<Option.Option<Active>>(Option.none());
    const visible = yield* Ref.make(yield* ui.visible);
    const ids = yield* Ref.make(0);
    const discoveryEpoch = yield* Ref.make(0);
    const events = yield* Queue.bounded<AppEvent>(128);
    const requests = yield* Queue.sliding<{
      readonly epoch: number;
      readonly visible: boolean;
    }>(1);
    yield* Effect.addFinalizer(() =>
      Queue.shutdown(events).pipe(Effect.asVoid),
    );
    yield* Effect.addFinalizer(() =>
      Queue.shutdown(requests).pipe(Effect.asVoid),
    );
    yield* Queue.offer(events, { _tag: "Tick" });

    const stop = Effect.gen(function* () {
      const old = yield* Ref.getAndSet(active, Option.none());
      if (Option.isSome(old)) yield* Fiber.interrupt(old.value.fiber);
    });
    const showNavigation = Effect.gen(function* () {
      const list = yield* Ref.get(panes);
      const selected = yield* Ref.get(selection);
      yield* ui.showPanes(
        list,
        Option.map(selected, (value) => value.paneId),
      );
    });
    const present = Effect.fnUntraced(function* (current: Active) {
      // Notifications only wake the dispatcher. Read the latest model so a
      // queued older status cannot overwrite a command's newer transition.
      const view = yield* current.attachment.view;
      if (view._tag !== "Controlling")
        yield* Ref.set(
          active,
          Option.some({
            ...current,
            autoFit: Option.none(),
            size: Option.none(),
          }),
        );
      yield* ui.showView(current.pane, view);
    });
    const select = Effect.fn("Application.select")(function* (pane: PaneId) {
      yield* stop;
      const list = yield* Ref.get(panes);
      const found = list.find((p) => p.id === pane);
      const selected: Selection =
        found === undefined ? { paneId: pane } : selectionOf(found);
      yield* Ref.set(selection, Option.some(selected));
      yield* preferences.save({ ...saved, selection: selected });
      yield* showNavigation;
      if (!(yield* Ref.get(visible))) return;
      const number = yield* Ref.updateAndGet(ids, (n) => n + 1);
      const id = yield* Schema.decodeUnknownEffect(AttachmentId)(number).pipe(
        Effect.mapError(
          () => new UiError({ message: "Attachment identity exhausted" }),
        ),
      );
      const attachment = yield* makeAttachment(id, pane, () =>
        Queue.offer(events, { _tag: "SessionView", id }).pipe(Effect.asVoid),
      );
      yield* ui.showView(pane, { _tag: "Connecting", attachment: id });
      const fiber = yield* attachment.run.pipe(
        Effect.catch((error) =>
          Queue.offer(events, {
            _tag: "SessionEnded",
            id,
            message: error.message,
          }),
        ),
        Effect.asVoid,
        Effect.forkScoped,
      );
      yield* Ref.set(
        active,
        Option.some({
          id,
          pane,
          attachment,
          fiber,
          autoFit: Option.none(),
          size: Option.none(),
        }),
      );
    });
    const discover = Effect.gen(function* () {
      const epoch = yield* Ref.updateAndGet(discoveryEpoch, (n) => n + 1);
      const enabled = yield* Ref.get(visible);
      yield* Queue.offer(requests, { epoch, visible: enabled });
    });
    const send = Effect.fn("Application.send")(function* (intent: Intent) {
      const current = yield* Ref.get(active);
      if (
        Option.isNone(current) ||
        current.value.id !== intent.lease.attachment
      ) {
        yield* ui.notice(
          "Attachment changed; input was not queued or replayed",
        );
        return;
      }
      yield* current.value.attachment
        .send(intent)
        .pipe(Effect.andThen(present(current.value)))
        .pipe(Effect.catch((error) => ui.notice(error.message)));
    });
    const resize = Effect.fn("Application.resize")(function* (
      lease: ControlLease,
      enable: boolean,
    ) {
      const current = yield* Ref.get(active);
      if (Option.isNone(current) || current.value.id !== lease.attachment)
        return;
      const owner = current.value;
      if (
        !enable &&
        (Option.isNone(owner.autoFit) ||
          owner.autoFit.value.generation !== lease.generation)
      )
        return;
      const dimensions = yield* ui.dimensions;
      if (Option.isNone(dimensions)) return;
      const size = dimensions.value;
      if (
        Option.isNone(owner.size) ||
        size.cols !== owner.size.value.cols ||
        size.rows !== owner.size.value.rows
      ) {
        yield* owner.attachment.send({
          _tag: "Resize",
          lease,
          dimensions: size,
        });
      }
      yield* Ref.set(
        active,
        Option.some({
          ...owner,
          autoFit: Option.some(lease),
          size: Option.some(size),
        }),
      );
    });
    const handle = Effect.fn("Application.handle")(function* (event: AppEvent) {
      switch (event._tag) {
        case "Tick":
          if (yield* Ref.get(visible)) yield* discover;
          return;
        case "Refresh":
          yield* discover;
          return;
        case "Visibility": {
          yield* Ref.set(visible, event.visible);
          if (!event.visible) yield* stop;
          yield* discover;
          return;
        }
        case "Snapshot": {
          if (
            event.epoch !== (yield* Ref.get(discoveryEpoch)) ||
            !(yield* Ref.get(visible))
          )
            return;
          const old = yield* Ref.get(panes);
          const updated = normalize(event.snapshot);
          const before = yield* Ref.get(selection);
          const next = selectPane(old, updated, before);
          yield* Ref.set(panes, updated);
          const current = yield* Ref.get(active);
          if (Option.isSome(next)) {
            if (Option.isNone(current) || current.value.pane !== next.value.id)
              yield* select(next.value.id);
          } else {
            yield* stop;
            yield* Ref.set(selection, Option.none());
            yield* ui.clear;
          }
          yield* showNavigation;
          yield* ui.notice(
            updated.length === 0 ? "Create a pane in Herdr to begin" : "",
          );
          return;
        }
        case "DiscoveryFailed":
          if (event.epoch === (yield* Ref.get(discoveryEpoch)))
            yield* ui.notice(`${event.message} · retrying`);
          return;
        case "Select": {
          const pane = yield* Schema.decodeUnknownEffect(PaneId)(
            event.value,
          ).pipe(
            Effect.mapError(
              () => new UiError({ message: "Choose a valid Herdr pane ID" }),
            ),
          );
          yield* select(pane);
          return;
        }
        case "Navigate": {
          const list = yield* Ref.get(panes);
          const selected = yield* Ref.get(selection);
          const index = list.findIndex(
            (p) => Option.isSome(selected) && p.id === selected.value.paneId,
          );
          const next = list[index + event.delta];
          if (next !== undefined) yield* select(next.id);
          return;
        }
        case "Reconnect": {
          const selected = yield* Ref.get(selection);
          if (Option.isSome(selected)) yield* select(selected.value.paneId);
          return;
        }
        case "SessionView": {
          const current = yield* Ref.get(active);
          if (Option.isNone(current) || current.value.id !== event.id) return;
          yield* present(current.value);
          return;
        }
        case "SessionEnded": {
          const current = yield* Ref.get(active);
          if (Option.isNone(current) || current.value.id !== event.id) return;
          yield* Ref.set(active, Option.none());
          yield* ui.showView(current.value.pane, {
            _tag: "Disconnected",
            attachment: event.id,
            message: `${event.message} · reconnecting in watch mode`,
          });
          return;
        }
        case "Control":
        case "Release":
          yield* send(event);
          return;
        case "Input": {
          const text = yield* Schema.decodeUnknownEffect(InputText)(
            event.text,
          ).pipe(
            Effect.mapError(
              () =>
                new UiError({ message: "Input is too large; it was not sent" }),
            ),
          );
          yield* send({ _tag: "Input", lease: event.lease, text });
          return;
        }
        case "Fit":
          yield* resize(event.lease, true);
          return;
        case "Resize":
          yield* resize(event.lease, false);
          return;
      }
    });
    const discovery = Stream.fromQueue(requests).pipe(
      Stream.switchMap(
        (request) =>
          request.visible
            ? Stream.fromEffect(
                transport.discover.pipe(
                  Effect.match({
                    onSuccess: (snapshot): AppEvent => ({
                      _tag: "Snapshot",
                      epoch: request.epoch,
                      snapshot,
                    }),
                    onFailure: (error): AppEvent => ({
                      _tag: "DiscoveryFailed",
                      epoch: request.epoch,
                      message: error.message,
                    }),
                  }),
                ),
              )
            : Stream.empty,
        { bufferSize: 1 },
      ),
      Stream.runForEach((event) => Queue.offer(events, event)),
    );
    const input = ui.events.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
    );
    const ticks = Stream.fromEffectSchedule(
      Queue.offer(events, { _tag: "Tick" }),
      Schedule.spaced("5 seconds"),
    ).pipe(Stream.runDrain);
    const dispatch = Effect.forever(
      Queue.take(events).pipe(
        Effect.flatMap((event) =>
          handle(event).pipe(Effect.catch((error) => ui.notice(error.message))),
        ),
      ),
    );
    yield* Effect.all([dispatch, input, ticks, discovery], {
      concurrency: "unbounded",
      discard: true,
    });
  }),
);
