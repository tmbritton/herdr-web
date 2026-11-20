import { Effect, Result } from "effect";
import type { Frame } from "./domain.ts";
import { UiError } from "./domain.ts";

export interface TerminalSink {
  readonly cols: number;
  readonly rows: number;
  resize(cols: number, rows: number): void;
  reset(): void;
  write(data: Uint8Array, done: () => void): void;
}

export const writeTerminal = Effect.fnUntraced(function* (
  terminal: TerminalSink,
  frame: Frame,
  bytes: Uint8Array,
  reset: boolean,
) {
  yield* Effect.try({
    try: () => {
      if (reset) terminal.reset();
      if (terminal.cols !== frame.cols || terminal.rows !== frame.rows)
        terminal.resize(frame.cols, frame.rows);
    },
    catch: () => new UiError({ message: "Could not prepare terminal display" }),
  });
  yield* Effect.callback<undefined, UiError>((resume) => {
    const result = Result.try({
      try: () => terminal.write(bytes, () => resume(Effect.succeed(undefined))),
      catch: () => new UiError({ message: "Could not render terminal output" }),
    });
    if (Result.isFailure(result)) resume(Effect.fail(result.failure));
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(
          new UiError({
            message:
              "Terminal rendering stalled; attach again for a fresh view",
          }),
        ),
    }),
  );
});

export const clearTerminal = (
  terminal: TerminalSink,
): Effect.Effect<void, UiError> =>
  Effect.callback<undefined, UiError>((resume) => {
    let active = true;
    const result = Result.try({
      try: () =>
        terminal.write(new Uint8Array(), () => {
          if (!active) return;
          const reset = Result.try({
            try: () => terminal.reset(),
            catch: () => new UiError({ message: "Could not clear terminal" }),
          });
          resume(
            Result.isFailure(reset)
              ? Effect.fail(reset.failure)
              : Effect.succeed(undefined),
          );
        }),
      catch: () => new UiError({ message: "Could not clear terminal" }),
    });
    if (Result.isFailure(result)) resume(Effect.fail(result.failure));
    return Effect.sync(() => {
      active = false;
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.fail(new UiError({ message: "Terminal did not clear" })),
    }),
  );
