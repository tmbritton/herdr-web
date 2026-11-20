import { Effect, Schema } from "effect";

export const HistorySession = Schema.String.check(
  Schema.isPattern(/^ses_[A-Za-z0-9_-]{1,128}$/),
).pipe(Schema.brand("HistorySession"));
export type HistorySession = typeof HistorySession.Type;
const Position = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 1000000000 }),
);
export const HistoryStart = Schema.Union([Schema.Literal("latest"), Position]);
export type HistoryStart = typeof HistoryStart.Type;
const PageFields = {
  session: HistorySession,
  title: Schema.String.check(Schema.isMaxLength(8192)),
  start: Position,
  total: Position,
};
const EntryFields = {
  message: Schema.NonEmptyString.check(Schema.isMaxLength(132)),
  role: Schema.Literals(["user", "assistant", "unknown"]),
  kind: Schema.Literals(["text", "reasoning", "tool", "file", "compaction"]),
  offset: Position,
};
export const HistoryPage = Schema.Struct({
  ...PageFields,
  entries: Schema.Array(
    Schema.Struct({
      ...EntryFields,
      text: Schema.String.check(Schema.isMaxLength(8192)),
    }),
  ).check(Schema.isMaxLength(16)),
}).check(
  Schema.makeFilter(
    (page) =>
      page.start <= page.total &&
      page.entries.length === Math.min(16, page.total - page.start),
    { expected: "a complete bounded transcript page" },
  ),
);
export type HistoryPage = typeof HistoryPage.Type;
export class HistoryError extends Schema.TaggedError<HistoryError>()(
  "HistoryError",
  { message: Schema.String },
) {}

const WirePage = Schema.Struct({
  ...PageFields,
  entries: Schema.Array(
    Schema.Struct({
      ...EntryFields,
      bytes: Schema.String.check(
        Schema.isMaxLength(8198),
        Schema.isPattern(/^(?:[0-9A-F]{2})+$/),
      ),
    }),
  ).check(Schema.isMaxLength(16)),
});
const invalid = () =>
  new HistoryError({ message: "History unavailable or invalid" });
export const decodeHistoryPage = Effect.fnUntraced(function* (input: unknown) {
  const wire = yield* Schema.decodeUnknownEffect(WirePage)(input).pipe(
    Effect.mapError(invalid),
  );
  const entries = yield* Effect.forEach(wire.entries, (entry) =>
    Effect.try({
      try: () => {
        const bytes = Uint8Array.from(entry.bytes.match(/../g) ?? [], (byte) =>
          Number.parseInt(byte, 16),
        );
        // Each wire segment has up to 3 overlap bytes. Skip an already-rendered
        // leading continuation, and finish a codepoint that starts before 4096.
        // This preserves Unicode, BOMs and NUL even when paging through one part.
        let start = 0;
        if (entry.offset > 0)
          while (start < 3 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
        let end = Math.min(4096, bytes.length);
        while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end++;
        const text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes.subarray(start, end));
        return { ...entry, text };
      },
      catch: invalid,
    }),
  );
  return yield* Schema.decodeUnknownEffect(HistoryPage)({
    ...wire,
    entries,
  }).pipe(Effect.mapError(invalid));
});
