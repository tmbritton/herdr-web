import { inputCommand } from "./domain.ts";
import type {
  ControlLease,
  Generation,
  InputText,
  PaneId,
  Sequence,
  WatchLease,
  AttachmentId,
  SubmissionId,
} from "./domain.ts";

// Compile-time regression assertions. These functions are never run.
export function capabilities(
  watch: WatchLease,
  control: ControlLease,
  text: InputText,
) {
  // @ts-expect-error A watch capability cannot authorize terminal input.
  inputCommand(watch, text);
  return inputCommand(control, text);
}
export function identities(unchecked: string, sequence: Sequence) {
  // @ts-expect-error A string must be validated before becoming a pane ID.
  const pane: PaneId = unchecked;
  // @ts-expect-error Frame sequence and attachment generation are distinct.
  const generation: Generation = sequence;
  return { pane, generation };
}

export function submissionIdentity(attachment: AttachmentId) {
  // @ts-expect-error A completion token cannot be an attachment identifier.
  const submission: SubmissionId = attachment;
  return submission;
}
