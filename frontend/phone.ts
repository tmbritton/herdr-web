import { Effect, Schema } from "effect";
import { InputText, UiError } from "./domain.ts";

export const TouchKey = Schema.Literals([
  "Escape",
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ControlC",
  "Enter",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
export const PasteStyle = Schema.Literals(["bracketed", "plain"]);

const keys: Record<typeof TouchKey.Type, string> = {
  Escape: "\x1b",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  ControlC: "\x03",
  Enter: "\r",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
};
const controlNavigation = new Map([
  ["\x1b[A", "\x1b[1;5A"],
  ["\x1b[B", "\x1b[1;5B"],
  ["\x1b[C", "\x1b[1;5C"],
  ["\x1b[D", "\x1b[1;5D"],
  ["\x1b[H", "\x1b[1;5H"],
  ["\x1b[F", "\x1b[1;5F"],
  ["\x1b[5~", "\x1b[5;5~"],
  ["\x1b[6~", "\x1b[6;5~"],
]);
const decodeInput = Schema.decodeUnknownEffect(InputText);
export const terminalInput = Effect.fnUntraced(function* (
  text: string,
  ctrl: boolean,
) {
  let input = text;
  if (ctrl) {
    const navigation = controlNavigation.get(text);
    if (navigation !== undefined) input = navigation;
    else {
      const code = text.toUpperCase().charCodeAt(0);
      if (
        text.length !== 1 ||
        text.charCodeAt(0) > 127 ||
        !(
          code <= 31 ||
          (code >= 64 && code <= 95) ||
          text === " " ||
          text === "?"
        )
      )
        return yield* new UiError({
          message: "Ctrl expects a single ASCII key",
        });
      input =
        code <= 31
          ? text
          : text === "?"
            ? "\x7f"
            : String.fromCharCode(text === " " ? 0 : code - 64);
    }
  }
  return yield* decodeInput(input).pipe(
    Effect.mapError(
      () =>
        new UiError({
          message: "Input is invalid or too large; it was not sent",
        }),
    ),
  );
});

export const keyInput = Effect.fnUntraced(function* (
  key: string,
  ctrl: boolean,
) {
  const valid = yield* Schema.decodeUnknownEffect(TouchKey)(key).pipe(
    Effect.mapError(() => new UiError({ message: "Unknown terminal key" })),
  );
  return yield* terminalInput(keys[valid], ctrl);
});

const PromptText = InputText.check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (text) => !/\p{Cc}/u.test(text.split("\n").join("").split("\t").join("")),
    { expected: "plain prompt text without terminal control sequences" },
  ),
);
export const pasteInput = Effect.fn("pasteInput")(function* (
  text: string,
  style: string,
) {
  const mode = yield* Schema.decodeUnknownEffect(PasteStyle)(style).pipe(
    Effect.mapError(
      () => new UiError({ message: "Choose a supported paste style" }),
    ),
  );
  const prompt = yield* Schema.decodeUnknownEffect(PromptText)(
    text.replace(/\r\n?/g, "\n"),
  ).pipe(
    Effect.mapError(
      () =>
        new UiError({
          message: "Prompt must be non-empty plain text within 16 KiB",
        }),
    ),
  );
  const input =
    mode === "bracketed"
      ? `\x1b[200~${prompt}\x1b[201~`
      : prompt.replace(/\n/g, "\r");
  return yield* decodeInput(input).pipe(
    Effect.mapError(
      () =>
        new UiError({
          message: "Prompt exceeds 16 KiB including paste framing",
        }),
    ),
  );
});

export const deliverPrompt = Effect.fn("deliverPrompt")(function* <E>(
  text: string,
  style: string,
  submit: boolean,
  current: Effect.Effect<boolean>,
  send: (text: InputText) => Effect.Effect<void, E>,
) {
  const paste = yield* pasteInput(text, style);
  if (!(yield* current))
    return yield* new UiError({ message: "Prompt cancelled" });
  yield* send(paste);
  if (submit) {
    yield* Effect.sleep("100 millis");
    if (!(yield* current))
      return yield* new UiError({
        message: "Submission cancelled",
      });
    const enter = yield* terminalInput("\r", false);
    yield* send(enter);
  }
});
