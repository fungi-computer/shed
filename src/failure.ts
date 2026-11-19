import * as Redacted from "effect/Redacted";
import { toast } from "@fungi.computer/caps/components/toaster";
import { AppError, describeAppError } from "@fungi.computer/agar/errors";
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
 * The one sentence a failure toast shows: the decoded cause when the failure
 * names one (a Computer refusal, or a host-stated AppError reason), otherwise
 * the caller's authored message. Exception text never reaches it.
 */
export function failureMessage(fallback: string, cause: unknown): string {
  if (cause instanceof ComputerDeclined) return cause.message;
  if (cause instanceof AppError && cause.reason !== undefined)
    return describeAppError(cause).message;
  return fallback;
}

export function reportCatchFailure(message: string, cause: unknown): void {
  reportCaughtError(cause);
  const shown = failureMessage(message, cause);
  toast.error(shown, { id: shown, closeButton: true });
}

export function reportCaughtError(cause: unknown): void {
  console.error("Shed operation failed", Redacted.make(cause));
}
