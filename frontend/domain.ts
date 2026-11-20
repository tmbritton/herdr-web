import { Schema } from "effect";

const PositiveInt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
export const PaneId = Schema.String.check(
  Schema.isPattern(/^w[1-9]\d*:p[1-9]\d*$/),
  Schema.isMaxLength(80),
).pipe(Schema.brand("PaneId"));
export type PaneId = typeof PaneId.Type;
export const TabId = Schema.String.check(
  Schema.isPattern(/^w[1-9]\d*:t[1-9]\d*$/),
  Schema.isMaxLength(80),
).pipe(Schema.brand("TabId"));
export const WorkspaceId = Schema.String.check(
  Schema.isPattern(/^w[1-9]\d*$/),
  Schema.isMaxLength(40),
).pipe(Schema.brand("WorkspaceId"));
export const TerminalId = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
).pipe(Schema.brand("TerminalId"));
export type TerminalId = typeof TerminalId.Type;
export const AttachmentId = PositiveInt.pipe(Schema.brand("AttachmentId"));
export type AttachmentId = typeof AttachmentId.Type;
export const SubmissionId = PositiveInt.pipe(Schema.brand("SubmissionId"));
export type SubmissionId = typeof SubmissionId.Type;
export const Generation = PositiveInt.pipe(Schema.brand("Generation"));
export type Generation = typeof Generation.Type;
export const Sequence = PositiveInt.pipe(Schema.brand("Sequence"));
export type Sequence = typeof Sequence.Type;
export const ViewCols = PositiveInt.check(
  Schema.isLessThanOrEqualTo(1000),
).pipe(Schema.brand("ViewCols"));
export const ViewRows = PositiveInt.check(Schema.isLessThanOrEqualTo(500)).pipe(
  Schema.brand("ViewRows"),
);
export const ControlCols = PositiveInt.check(
  Schema.isLessThanOrEqualTo(400),
).pipe(Schema.brand("ControlCols"));
export const ControlRows = PositiveInt.check(
  Schema.isLessThanOrEqualTo(200),
).pipe(Schema.brand("ControlRows"));
export const Dimensions = Schema.Struct({
  cols: ControlCols,
  rows: ControlRows,
});
export type Dimensions = typeof Dimensions.Type;
export const FontSize = Schema.Int.check(
  Schema.isBetween({ minimum: 10, maximum: 24 }),
).pipe(Schema.brand("FontSize"));
export type FontSize = typeof FontSize.Type;
const encoder = new TextEncoder();
export const InputText = Schema.String.check(
  Schema.isPattern(/^[^\p{Surrogate}]*$/u),
  Schema.makeFilter((text) => encoder.encode(text).byteLength <= 16384, {
    expected: "at most 16 KiB of UTF-8 input",
  }),
).pipe(Schema.brand("InputText"));
export type InputText = typeof InputText.Type;
export const TerminalBytes = Schema.Uint8Array.check(
  Schema.isMaxLength(1048576),
);
const ScrollFields = {
  direction: Schema.Literals(["up", "down"]),
  steps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 })),
  column: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  row: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 499 })),
};
export const Scroll = Schema.Struct(ScrollFields).pipe(Schema.brand("Scroll"));
export type Scroll = typeof Scroll.Type;

export const Frame = Schema.Struct({
  type: Schema.Literal("frame"),
  generation: Generation,
  seq: Sequence,
  cols: ViewCols,
  rows: ViewRows,
  full: Schema.Boolean,
});
export type Frame = typeof Frame.Type;
export const Mode = Schema.Literals(["watch", "requesting-control", "control"]);
export type Mode = typeof Mode.Type;
export const ModeRecord = Schema.Struct({
  type: Schema.Literal("mode"),
  generation: Generation,
  mode: Mode,
  reason: Schema.String.check(Schema.isMaxLength(4096)),
});
export const ErrorRecord = Schema.Struct({
  type: Schema.Literal("error"),
  reason: Schema.String.check(Schema.isMaxLength(4096)),
});
export const ServerRecord = Schema.Union([
  Frame,
  ModeRecord,
  ErrorRecord,
  Schema.Struct({ type: Schema.Literal("pong") }),
]);
export type ServerRecord = typeof ServerRecord.Type;
export const ServerJson = Schema.fromJsonString(ServerRecord);

export const ClientCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ping"), generation: Generation }),
  Schema.Struct({
    type: Schema.Literal("ack"),
    generation: Generation,
    seq: Sequence,
  }),
  Schema.Struct({
    type: Schema.Literal("control"),
    generation: Generation,
    takeover: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("release"), generation: Generation }),
  Schema.Struct({
    type: Schema.Literal("input"),
    generation: Generation,
    text: InputText,
  }),
  Schema.Struct({
    type: Schema.Literal("resize"),
    generation: Generation,
    cols: ControlCols,
    rows: ControlRows,
  }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    generation: Generation,
    ...ScrollFields,
  }),
]);
export type ClientCommand = typeof ClientCommand.Type;
export const ClientJson = Schema.fromJsonString(ClientCommand);

const Label = Schema.String.check(Schema.isMaxLength(4096));
const Coordinate = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 65535 }),
);
const RawPane = Schema.Struct({
  pane_id: PaneId,
  terminal_id: TerminalId,
  workspace_id: WorkspaceId,
  tab_id: TabId,
  label: Schema.optionalKey(Label),
  title: Schema.optionalKey(Label),
});
const RawTab = Schema.Struct({
  tab_id: TabId,
  workspace_id: WorkspaceId,
  number: PositiveInt,
  label: Label,
});
const RawWorkspace = Schema.Struct({
  workspace_id: WorkspaceId,
  number: PositiveInt,
  label: Label,
});
const RawLayout = Schema.Struct({
  panes: Schema.Array(
    Schema.Struct({
      pane_id: PaneId,
      rect: Schema.Struct({ x: Coordinate, y: Coordinate }),
    }),
  ).check(Schema.isMaxLength(4096)),
});
const SnapshotBody = Schema.Struct({
  panes: Schema.Array(RawPane).check(Schema.isMaxLength(4096)),
  tabs: Schema.Array(RawTab).check(Schema.isMaxLength(4096)),
  workspaces: Schema.Array(RawWorkspace).check(Schema.isMaxLength(4096)),
  layouts: Schema.Array(RawLayout).check(Schema.isMaxLength(4096)),
}).check(
  Schema.makeFilter(
    (snapshot) => {
      const paneIds = new Set(snapshot.panes.map((p) => p.pane_id));
      const terminalIds = new Set(snapshot.panes.map((p) => p.terminal_id));
      const tabIds = new Set(snapshot.tabs.map((t) => t.tab_id));
      const workspaceIds = new Set(
        snapshot.workspaces.map((w) => w.workspace_id),
      );
      return (
        paneIds.size === snapshot.panes.length &&
        terminalIds.size === snapshot.panes.length &&
        tabIds.size === snapshot.tabs.length &&
        workspaceIds.size === snapshot.workspaces.length &&
        snapshot.tabs.every((t) => workspaceIds.has(t.workspace_id)) &&
        snapshot.panes.every(
          (p) =>
            workspaceIds.has(p.workspace_id) &&
            snapshot.tabs.some(
              (t) => t.tab_id === p.tab_id && t.workspace_id === p.workspace_id,
            ),
        )
      );
    },
    {
      expected:
        "unique pane/terminal identities and coherent workspace/tab references",
    },
  ),
);
export const Snapshot = Schema.Struct({
  result: Schema.Struct({ snapshot: SnapshotBody }),
});
export type Snapshot = typeof Snapshot.Type;
export const Pane = Schema.Struct({
  id: PaneId,
  terminalId: TerminalId,
  label: Label,
  group: Label,
  tabId: TabId,
});
export type Pane = typeof Pane.Type;
export const Selection = Schema.Struct({
  paneId: PaneId,
  terminalId: Schema.optionalKey(TerminalId),
});
export type Selection = typeof Selection.Type;
export const Preferences = Schema.Struct({
  selection: Schema.optionalKey(Selection),
  fontSize: Schema.optionalKey(FontSize),
});
export type Preferences = typeof Preferences.Type;

export class ProtocolError extends Schema.TaggedError<ProtocolError>()(
  "ProtocolError",
  { message: Schema.String },
) {}
export class CommandRejected extends Schema.TaggedError<CommandRejected>()(
  "CommandRejected",
  { message: Schema.String },
) {}
export class TransportError extends Schema.TaggedError<TransportError>()(
  "TransportError",
  {
    operation: Schema.Literals(["discover", "connect", "read", "write"]),
    message: Schema.String,
  },
) {}
export class UiError extends Schema.TaggedError<UiError>()("UiError", {
  message: Schema.String,
}) {}
export class EventOverflow extends Schema.TaggedError<EventOverflow>()(
  "EventOverflow",
  {},
) {}

export const WatchLease = Schema.Struct({
  attachment: AttachmentId,
  generation: Generation,
}).pipe(Schema.brand("WatchLease"));
export type WatchLease = typeof WatchLease.Type;
export const ControlLease = Schema.Struct({
  attachment: AttachmentId,
  generation: Generation,
}).pipe(Schema.brand("ControlLease"));
export type ControlLease = typeof ControlLease.Type;
export const View = Schema.TaggedUnion({
  Connecting: { attachment: AttachmentId },
  AwaitingSnapshot: {
    attachment: AttachmentId,
    generation: Generation,
    mode: Mode,
    busy: Schema.Boolean,
  },
  Watching: {
    lease: WatchLease,
    seq: Sequence,
    cols: ViewCols,
    rows: ViewRows,
    busy: Schema.Boolean,
  },
  Controlling: {
    lease: ControlLease,
    seq: Sequence,
    cols: ViewCols,
    rows: ViewRows,
  },
  Disconnected: { attachment: AttachmentId, message: Schema.String },
});
export type View = typeof View.Type;

export function inputCommand(
  lease: ControlLease,
  text: InputText,
): ClientCommand {
  return { type: "input", generation: lease.generation, text };
}
