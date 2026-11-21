import * as Redacted from "effect/Redacted";
import { toast } from "@fungi.computer/caps/components/toaster";
import { typedFailureMessage } from "@fungi.computer/agar/errors";
import { describeComputerRefusal } from "@fungi.computer/agar/computer";
import type { RunCommandRefusal } from "./light-shell/run-command-contract.js";

/** A Computer refusal a Shed App method returned, carried to the one toast. */
export class ComputerDeclined extends Error {
  readonly refusal: RunCommandRefusal;
  constructor(refusal: RunCommandRefusal) {
    super(describeComputerRefusal(refusal).message);
    this.name = "ComputerDeclined";
    this.refusal = refusal;
  }
}

/**
 * The one sentence a failure toast shows: what failed, then the decoded cause
 * (a Computer refusal, or an App error's stated cause). Any other rejection
 * may carry private host text, so it says only that the host returned an error
 * it did not describe; exception text never reaches the toast.
 */
export function failureMessage(what: string, cause: unknown): string {
  if (cause instanceof ComputerDeclined) return `${what}: ${cause.message}`;
  return typedFailureMessage(what, cause);
}

export function reportCatchFailure(message: string, cause: unknown): void {
  reportCaughtError(cause);
  const shown = failureMessage(message, cause);
  toast.error(shown, { id: shown, closeButton: true });
}

export function reportCaughtError(cause: unknown): void {
  console.error("Shed operation failed", Redacted.make(cause));
}
