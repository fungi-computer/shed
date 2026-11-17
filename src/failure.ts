import * as Redacted from "effect/Redacted";
import { toast } from "@fungi.computer/caps/components/toaster";

/** Only authored messages reach the toast; exception and command data stay redacted. */
export function reportCatchFailure(message: string, cause: unknown): void {
  reportCaughtError(cause);
  toast.error(message, { id: message, closeButton: true });
}

/** Cleanup and cancelled work retain diagnostics without interrupting the person. */
export function reportCaughtError(cause: unknown): void {
  console.error("Shed operation failed", Redacted.make(cause));
}
