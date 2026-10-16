import * as Redacted from "effect/Redacted";

/** Retain the original Shed failure without printing exception or command data. */
export function reportCatchFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "shed",
      operation,
      failureKind: cause instanceof Error ? cause.name : "NonErrorThrown",
    }),
    Redacted.make(cause),
  );
}
