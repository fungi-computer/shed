import {
  runObservationSchema,
  type RunObservation,
} from "@fungi.computer/agar/run-observation";
import type { ComputerProcess } from "@fungi.computer/computer-contract";

/** What Shed's own process record adds to the Computer's. */
export type ShedProcessRecord = Readonly<{
  /** The process this one restarted. */
  parentId: string | null;
  /** When Shed signalled this process to stop at its caller's request. */
  stoppedAt: number | null;
  logPath: string;
}>;

type Standing = Pick<RunObservation, "state" | "reason">;

/**
 * The Computer's record decides what happened; Shed's adds only that its caller
 * stopped the process, which is a fact the Computer cannot know. A caller's
 * stop wins over how the process then exited.
 */
function standing(
  process: ComputerProcess,
  record: ShedProcessRecord | null,
): Standing {
  const stopped = (record?.stoppedAt ?? null) !== null;
  if (process.state === "uncertain")
    return { state: "unknown", reason: "computer_unreachable" };
  if (process.state === "running")
    return stopped
      ? { state: "running", reason: "stopping" }
      : { state: "running" };
  if (stopped) return { state: "cancelled", reason: "stopped" };
  if (process.endedReason === "idle-sleep")
    return { state: "failed", reason: "computer_slept" };
  if (process.exitCode === null)
    return { state: "unknown", reason: "exit_unobserved" };
  return process.exitCode === 0
    ? { state: "completed" }
    : { state: "failed", reason: "nonzero_exit" };
}

/**
 * A read view of one Computer process as a run. Nothing here is stored: the
 * Computer's inventory and Shed's call record are the sources, and cost stays
 * null because no owner meters a process.
 */
export function observeProcess(
  process: ComputerProcess,
  record: ShedProcessRecord | null,
  log: RunObservation["log"],
): RunObservation {
  const observation: RunObservation = {
    source: "shed.process",
    id: process.id,
    ...standing(process, record),
    requestedAt: process.startedAt,
    startedAt: process.startedAt,
    log,
    outputs: record === null ? [] : [{ kind: "log", ref: record.logPath }],
    cost: null,
  };
  if (record?.parentId) observation.parentId = record.parentId;
  if (process.endedAt !== null) observation.endedAt = process.endedAt;
  return runObservationSchema.parse(observation);
}
