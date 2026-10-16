import * as z from "zod";
import {
  computerExecutionRequestSchema,
  computerOperationResultSchema,
  execOutputSchema,
  maximumStreamBytes,
  pathSchema,
} from "@fungi.computer/computer/operations";

/** Backend-mediated refusal of a Computer operation. Shared by every Shed App
 * method that can be declined instead of run. */
export const shedComputerRefusalSchema = z.union([
  z.strictObject({
    error: z.enum([
      "not_granted",
      "revoked",
      "grantor_lost_authority",
      "unavailable",
      "invalid",
      "invalid_path",
      "too_large",
      "conflict",
      "not_found",
    ]),
  }),
  z.strictObject({
    error: z.literal("attachment_budget_exceeded"),
    kind: z.enum(["exec", "write"]),
    retryAfterMs: z.number().int().min(1).max(86400000),
  }),
  z.strictObject({
    error: z.literal("timeout"),
    requestId: computerOperationResultSchema.shape.requestId,
  }),
]);

const workspacePath = pathSchema.refine(
  (value) => !value.split("/").includes(".."),
  "Parent path segments are not allowed",
);

/**
 * Wire contract for the Shed `runCommand` App method: one host-mediated
 * Computer exec, used today by the light shell prompt (routed-light
 * commands) through `app.methods`. The method's own replay identity and
 * backend selection stay host-owned, so the model/page input omits them.
 */
export const runCommandInputSchema = computerExecutionRequestSchema({
  maximumTimeMs: 45000,
})
  .omit({ requestId: true, backend: true })
  .extend({ cwd: workspacePath.optional() });

// A byte slice ending inside UTF-8 can decode to a replacement character,
// adding at most two encoded bytes to each native bounded stream.
const maximumDecodedStreamBytes = maximumStreamBytes + 2;
const runCommandOutputSchema = execOutputSchema
  .extend({
    stdout: z.string().max(maximumDecodedStreamBytes),
    stderr: z.string().max(maximumDecodedStreamBytes),
  })
  .refine(
    (value) =>
      new TextEncoder().encode(value.stdout).byteLength <=
        maximumDecodedStreamBytes &&
      new TextEncoder().encode(value.stderr).byteLength <=
        maximumDecodedStreamBytes,
    "Command stream exceeds the native Computer output bound",
  );

export const runCommandResultSchema = z.union([
  computerOperationResultSchema.extend({
    output: runCommandOutputSchema.nullable(),
  }),
  shedComputerRefusalSchema,
]);
