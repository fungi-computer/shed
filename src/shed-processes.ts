import { useRef } from "react";
import { replayKey } from "@fungi.computer/cairn";
import * as Redacted from "effect/Redacted";
import type { ShedProcessCommand } from "./shed-data.js";
import { AppError } from "@fungi.computer/agar";
import {
  computerProcesses,
  computerProcessSchema,
  type ComputerProcessStart,
} from "@fungi.computer/agar/computer";
import { Option, Schema } from "effect";
import {
  capabilityQuery,
  queryKeys,
  type QueryApp,
} from "@fungi.computer/agar/query";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

const readProcessId = Schema.decodeUnknownOption(
  computerProcessSchema.fields.id,
);

export type ProcessAction = "stopping" | "failed";

/** Inventory belongs to the Computer; pending actions belong to Query. */
export function useShedProcesses(app: QueryApp | null, visible: boolean) {
  const client = useQueryClient();
  const enabled =
    app?.context.get().computerId != null &&
    app.capabilities.has(computerProcesses);
  const queryKey = queryKeys.of(app, "processes");
  const query = useQuery({
    ...capabilityQuery(app, computerProcesses, queryKey, (handle) =>
      handle.list(),
    ),
    enabled,
    refetchInterval: visible ? 10_000 : false,
  });
  // Capture this Computer's handle before a selection change can replace it.
  const handle = enabled ? app.capabilities.require(computerProcesses) : null;
  const stop = useMutation({
    mutationKey: queryKey,
    mutationFn: (id: string) => {
      if (!handle)
        throw new AppError("Processes are not granted", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return handle.kill(id);
    },
    onSettled: () => client.invalidateQueries({ queryKey, exact: true }),
  });
  const retryIntent = useRef<{ input: string; requestId: string } | null>(null);
  const start = useMutation({
    mutationKey: queryKeys.of(app, "process-start"),
    mutationFn: (input: ComputerProcessStart) => {
      if (!handle)
        throw new AppError("Processes are not granted", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      return handle.start(input);
    },
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey, exact: true }),
        client.invalidateQueries({
          queryKey: queryKeys.of(app, "ports"),
          exact: true,
        }),
      ]),
  });
  async function startCommand(input: ShedProcessCommand): Promise<boolean> {
    const identity = JSON.stringify(input);
    const intent =
      retryIntent.current?.input === identity
        ? retryIntent.current
        : { input: identity, requestId: replayKey() };
    retryIntent.current = intent;
    try {
      await start.mutateAsync({ ...input, requestId: intent.requestId });
      if (retryIntent.current === intent) retryIntent.current = null;
      return true;
    } catch (cause) {
      console.error("Shed process start failed", Redacted.make(cause));
      return false;
    }
  }
  const mutations = useMutationState({
    filters: { mutationKey: queryKey, exact: true },
    select: ({ state }) => ({
      id: Option.getOrNull(readProcessId(state.variables)),
      status: state.status,
    }),
  });
  const actions = new Map<string, ProcessAction>();
  for (const { id, status } of mutations) {
    if (id === null) continue;
    // Later attempts replace the previous failure for this row only.
    if (status === "pending") actions.set(id, "stopping");
    else if (status === "error") actions.set(id, "failed");
    else actions.delete(id);
  }
  return { query, stop, actions, enabled, startCommand };
}
