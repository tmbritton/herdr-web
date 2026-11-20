import { Effect, Option, Schema } from "effect";
import type {
  AttachmentId,
  ClientCommand,
  ControlLease,
  Dimensions,
  Frame,
  InputText,
  ModeRecord,
  View,
  WatchLease,
} from "./domain.ts";
import {
  CommandRejected,
  ProtocolError,
  ServerJson,
  TerminalBytes,
  WatchLease as WatchCapability,
  ControlLease as ControlCapability,
} from "./domain.ts";

const machineBrand: unique symbol = Symbol("Machine");
type Common = {
  readonly [machineBrand]: true;
  readonly attachment: AttachmentId;
  readonly view: View;
  readonly desired: "watch" | "control";
};
type Active = Common & {
  readonly mode: typeof ModeRecord.Type;
  readonly last: Option.Option<Frame>;
  readonly busy: boolean;
};
export type Machine =
  | (Common & { readonly _tag: "AwaitingMode" })
  | (Active & { readonly _tag: "AwaitingFrame" })
  | (Active & { readonly _tag: "AwaitingBytes"; readonly frame: Frame })
  | Rendering;
export type Rendering = Active & {
  readonly _tag: "Rendering";
  readonly frame: Frame;
};
export type Transition =
  | { readonly _tag: "Updated"; readonly machine: Machine }
  | {
      readonly _tag: "Render";
      readonly machine: Rendering;
      readonly bytes: Uint8Array;
    };
export type Intent =
  | {
      readonly _tag: "Control";
      readonly lease: WatchLease;
      readonly takeover: boolean;
    }
  | { readonly _tag: "Release"; readonly lease: ControlLease }
  | {
      readonly _tag: "Input";
      readonly lease: ControlLease;
      readonly text: InputText;
    }
  | {
      readonly _tag: "Resize";
      readonly lease: ControlLease;
      readonly dimensions: Dimensions;
    };

export const initial = (attachment: AttachmentId): Machine => ({
  [machineBrand]: true,
  _tag: "AwaitingMode",
  attachment,
  desired: "watch",
  view: { _tag: "Connecting", attachment },
});
const MetadataText = Schema.String.check(Schema.isMaxLength(65536));
const decodeText = Schema.decodeUnknownEffect(MetadataText);
const decodeRecord = Schema.decodeUnknownEffect(ServerJson);
const decodeBytes = Schema.decodeUnknownEffect(TerminalBytes);

function project(active: Active): View {
  const { attachment, mode, desired, last, busy } = active;
  const pendingMode =
    desired === "watch" && mode.mode === "control"
      ? "watch"
      : desired === "control" && mode.mode === "watch"
        ? "requesting-control"
        : mode.mode;
  if (
    Option.isNone(last) ||
    pendingMode === "requesting-control" ||
    pendingMode !== mode.mode
  ) {
    return {
      _tag: "AwaitingSnapshot",
      attachment,
      generation: mode.generation,
      mode: pendingMode,
      busy,
    };
  }
  const { seq, cols, rows } = last.value;
  if (mode.mode === "control")
    return {
      _tag: "Controlling",
      lease: ControlCapability.make({
        attachment,
        generation: mode.generation,
      }),
      seq,
      cols,
      rows,
    };
  return {
    _tag: "Watching",
    lease: WatchCapability.make({ attachment, generation: mode.generation }),
    seq,
    cols,
    rows,
    busy,
  };
}

export const consume = Effect.fnUntraced(function* (
  machine: Machine,
  packet: string | Uint8Array,
): Effect.fn.Return<Transition, ProtocolError> {
  if (typeof packet !== "string") {
    const bytes = yield* decodeBytes(packet).pipe(
      Effect.mapError(
        () =>
          new ProtocolError({
            message: "Terminal frame exceeds the output limit",
          }),
      ),
    );
    if (machine._tag !== "AwaitingBytes")
      return yield* new ProtocolError({
        message: "Terminal bytes arrived without frame metadata",
      });
    return {
      _tag: "Render",
      machine: { ...machine, _tag: "Rendering" },
      bytes,
    };
  }
  const text = yield* decodeText(packet).pipe(
    Effect.mapError(
      () => new ProtocolError({ message: "Oversized terminal metadata" }),
    ),
  );
  const record = yield* decodeRecord(text).pipe(
    Effect.mapError(
      () => new ProtocolError({ message: "Invalid terminal metadata" }),
    ),
  );
  if (record.type === "error")
    return yield* new ProtocolError({ message: record.reason });
  if (record.type === "pong") return { _tag: "Updated", machine };
  if (machine._tag === "AwaitingBytes" || machine._tag === "Rendering")
    return yield* new ProtocolError({ message: "Interrupted terminal frame" });
  if (record.type === "mode") {
    if (machine._tag === "AwaitingMode" && record.mode !== "watch")
      return yield* new ProtocolError({
        message: "New attachments must start in watch mode",
      });
    if (record.mode !== "watch" && machine.desired !== "control")
      return yield* new ProtocolError({
        message: "Control was not explicitly requested",
      });
    const newer =
      machine._tag === "AwaitingMode" ||
      record.generation > machine.mode.generation;
    if (machine._tag !== "AwaitingMode") {
      if (record.generation < machine.mode.generation)
        return yield* new ProtocolError({
          message: "Stale attachment generation",
        });
      if (
        !newer &&
        record.mode !== machine.mode.mode &&
        !(
          machine.mode.mode === "requesting-control" &&
          record.mode === "control"
        )
      )
        return yield* new ProtocolError({
          message: "Mode changed without a fresh attachment",
        });
    }
    const active: Active = {
      [machineBrand]: true,
      attachment: machine.attachment,
      mode: record,
      desired: newer && record.mode === "watch" ? "watch" : machine.desired,
      last: newer ? Option.none() : machine.last,
      busy:
        record.reason === "control_busy" ||
        (!newer && record.reason === "" && machine.busy),
      view: machine.view,
    };
    return {
      _tag: "Updated",
      machine: { ...active, _tag: "AwaitingFrame", view: project(active) },
    };
  }
  if (
    machine._tag !== "AwaitingFrame" ||
    machine.mode.mode === "requesting-control"
  )
    return yield* new ProtocolError({
      message: "Frame arrived before attachment mode",
    });
  if (
    record.generation !== machine.mode.generation ||
    (Option.isSome(machine.last) && record.seq <= machine.last.value.seq)
  )
    return yield* new ProtocolError({
      message: "Stale or out-of-order terminal frame",
    });
  if (Option.isNone(machine.last) && !record.full)
    return yield* new ProtocolError({
      message: "A fresh attachment requires a full snapshot",
    });
  return {
    _tag: "Updated",
    machine: { ...machine, _tag: "AwaitingBytes", frame: record },
  };
});

export function complete(machine: Rendering): {
  readonly machine: Machine;
  readonly ack: ClientCommand;
} {
  const active: Active = {
    [machineBrand]: true,
    attachment: machine.attachment,
    mode: machine.mode,
    desired: machine.desired,
    last: Option.some(machine.frame),
    busy: machine.busy,
    view: machine.view,
  };
  return {
    machine: { ...active, _tag: "AwaitingFrame", view: project(active) },
    ack: {
      type: "ack",
      generation: machine.frame.generation,
      seq: machine.frame.seq,
    },
  };
}

export const authorize = Effect.fnUntraced(function* (
  machine: Machine,
  intent: Intent,
): Effect.fn.Return<
  { readonly machine: Machine; readonly command: ClientCommand },
  CommandRejected
> {
  const view = machine.view;
  if (
    (view._tag !== "Watching" && view._tag !== "Controlling") ||
    view.lease.attachment !== intent.lease.attachment ||
    view.lease.generation !== intent.lease.generation
  )
    return yield* new CommandRejected({
      message: "Attachment or control ownership changed",
    });
  const generation = intent.lease.generation;
  switch (intent._tag) {
    case "Control": {
      if (view._tag !== "Watching")
        return yield* new CommandRejected({
          message: "Already controlling this pane",
        });
      return {
        machine: {
          ...machine,
          desired: "control",
          view: {
            _tag: "AwaitingSnapshot",
            attachment: machine.attachment,
            generation,
            mode: "requesting-control",
            busy: false,
          },
        },
        command: { type: "control", generation, takeover: intent.takeover },
      };
    }
    case "Release": {
      if (view._tag !== "Controlling")
        return yield* new CommandRejected({
          message: "Not controlling this pane",
        });
      return {
        machine: {
          ...machine,
          desired: "watch",
          view: {
            _tag: "AwaitingSnapshot",
            attachment: machine.attachment,
            generation,
            mode: "watch",
            busy: false,
          },
        },
        command: { type: "release", generation },
      };
    }
    case "Input": {
      if (view._tag !== "Controlling")
        return yield* new CommandRejected({
          message: "Input requires control",
        });
      return {
        machine,
        command: { type: "input", generation, text: intent.text },
      };
    }
    case "Resize": {
      if (view._tag !== "Controlling")
        return yield* new CommandRejected({
          message: "Resizing requires control",
        });
      return {
        machine,
        command: { type: "resize", generation, ...intent.dimensions },
      };
    }
  }
});
