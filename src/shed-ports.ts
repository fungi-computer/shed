import { AppError } from "@fungi.computer/agar";
import {
  computerPorts,
  computerPortExposureSchema,
  listComputerPorts,
} from "@fungi.computer/agar/computer";
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
import { Option, Schema } from "effect";

export type ComputerPortsStatus =
  "loading" | "loaded" | "error" | "unavailable" | "not-configured";
export type PortAction = { expose: boolean; status: "pending" | "failed" };
const portChangeSchema = Schema.Struct({
  port: computerPortExposureSchema.fields.port,
  expose: Schema.Boolean,
});
type PortChange = Schema.Schema.Type<typeof portChangeSchema>;
const readPortChange = Schema.decodeUnknownOption(portChangeSchema);

/** Computer owns exposed URLs; Query owns pending requests and row failures. */
export function useShedPorts(app: QueryApp | null, visible: boolean) {
  const client = useQueryClient();
  const enabled =
    app?.context.get().computerId != null &&
    app.capabilities.has(computerPorts);
  const queryKey = queryKeys.of(app, "ports");
  const query = useQuery({
    ...capabilityQuery(app, computerPorts, queryKey, () => {
      if (!app)
        throw new AppError("No App connection", {
          code: "DISCONNECTED",
          retryable: true,
        });
      // Preserve Agar's URL and expiration validation.
      return listComputerPorts(app.capabilities);
    }),
    enabled,
    refetchInterval: (query) =>
      visible && !(query.state.data && "error" in query.state.data)
        ? 10_000
        : false,
  });
  const handle = enabled ? app.capabilities.require(computerPorts) : null;
  const mutation = useMutation({
    mutationKey: queryKey,
    mutationFn: async ({ port, expose }: PortChange) => {
      if (!handle)
        throw new AppError("Ports are not granted", {
          code: "CAPABILITY_DENIED",
          retryable: false,
        });
      if (expose) await handle.expose(port);
      else await handle.unexpose(port);
    },
    onSettled: () => client.invalidateQueries({ queryKey, exact: true }),
  });
  const mutations = useMutationState({
    filters: { mutationKey: queryKey, exact: true },
    select: ({ state }) => ({
      change: Option.getOrNull(readPortChange(state.variables)),
      status: state.status,
    }),
  });
  const actions = new Map<number, PortAction>();
  for (const { change, status } of mutations) {
    if (!change) continue;
    if (status === "pending" || status === "error")
      actions.set(change.port, {
        expose: change.expose,
        status: status === "pending" ? "pending" : "failed",
      });
    else actions.delete(change.port);
  }
  const status: ComputerPortsStatus = !enabled
    ? "unavailable"
    : query.isPending
      ? "loading"
      : query.isError
        ? "error"
        : "error" in query.data
          ? "not-configured"
          : query.isFetching
            ? "loading"
            : "loaded";
  return {
    query,
    enabled,
    status,
    actions,
    ports:
      enabled && query.data && "ports" in query.data ? query.data.ports : null,
    // Query retains row failures; the form also needs the completed result.
    change: async (port: number, expose: boolean): Promise<boolean> => {
      try {
        await mutation.mutateAsync({ port, expose });
        return true;
      } catch {
        return false;
      }
    },
  };
}
