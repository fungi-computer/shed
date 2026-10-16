import { AppError, type CapabilityDirectory } from "@fungi.computer/agar";
import { appMethods } from "@fungi.computer/agar/backend";
import { bareNavigationCommand } from "@fungi.computer/computer/light-shell";
import {
  runCommandInputSchema,
  runCommandResultSchema,
} from "./run-command-contract.js";
import type { LightRunInput, LightRunResult } from "./panel.js";

/**
 * Run one light-routed command through the Shed App's own `runCommand`
 * method — the same host-mediated Computer exec path every other Shed
 * caller (processes, workflow git pass) already uses on both Hub and
 * standalone Oyster.
 */
export async function runLightCommand(
  capabilities: CapabilityDirectory,
  input: LightRunInput,
  signal: AbortSignal,
): Promise<LightRunResult> {
  // The exec primitive has no state event yet (slice S1 of the light shell
  // proposal): each light run is its own process, so a bare `cd`/`export`
  // would otherwise report success and persist nothing. Refuse it honestly
  // instead of faking a result.
  const bare = bareNavigationCommand(input.command);
  if (bare)
    return {
      stdout: "",
      stderr: `light: ${bare.name} does not persist here yet; run \`full ${input.command}\` instead.\n`,
      exitCode: 1,
      cwd: input.cwd,
      env: input.env,
    };
  if (!capabilities.has(appMethods))
    throw new AppError("Computer execution is not available", {
      code: "CAPABILITY_DENIED",
      retryable: false,
    });
  const request = runCommandInputSchema.parse({
    command: input.command,
    cwd: input.cwd,
  });
  const raw = await capabilities
    .require(appMethods)
    .call("runCommand", JSON.stringify(request));
  signal.throwIfAborted();
  const result = runCommandResultSchema.parse(raw);
  if ("error" in result)
    throw new AppError(`The Computer declined this command: ${result.error}`, {
      code: "CAPABILITY_DENIED",
      retryable: result.error === "unavailable",
    });
  if (result.output === null)
    throw new AppError("The command produced no result", {
      code: "DISCONNECTED",
      retryable: true,
    });
  return {
    stdout: result.output.stdout,
    stderr: result.output.stderr,
    exitCode: result.output.exitCode,
    cwd: input.cwd,
    env: input.env,
  };
}
