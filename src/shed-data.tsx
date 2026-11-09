import type {
  ComputerProcess,
  ComputerProcessLogs,
  ComputerRefusal,
  ComputerPorts,
} from "@fungi.computer/agar/computer";
import { createContext, useContext } from "react";
import type { PortAction, ComputerPortsStatus } from "./shed-ports.js";
import type { ProcessAction } from "./shed-processes.js";

export type ShedProcessCommand = { command: string; port?: number };

export type ShedData = {
  ports: {
    items: ComputerPorts["ports"] | null;
    status: ComputerPortsStatus;
    actions?: ReadonlyMap<number, PortAction>;
    refresh?: () => void | Promise<void>;
    expose?: (port: number) => boolean | Promise<boolean>;
    unexpose?: (port: number) => void | Promise<void>;
  };
  processes: {
    items: readonly ComputerProcess[] | null;
    loading: boolean;
    /** Why the inventory cannot be read, in plain words, or null when it can. */
    error: ComputerRefusal | null;
    /** The one action that fixes `error`, when this window can offer it. */
    fix?: () => void | Promise<void>;
    actions?: ReadonlyMap<string, ProcessAction>;
    refresh?: () => void | Promise<void>;
    stop?: (id: string) => void | Promise<void>;
    start?: (input: ShedProcessCommand) => boolean | Promise<boolean>;
    unavailableReason?: string | undefined;
    output?:
      | {
          processId: string | null;
          data: ComputerProcessLogs | null;
          loading: boolean;
          failed: boolean;
          retry(): void | Promise<void>;
          select(id: string | null): void;
        }
      | undefined;
  };
};

/** The workspace owns Query; layout and trays consume its Computer readouts. */
export const ShedDataContext = createContext<ShedData | null>(null);

export function useShedData(): ShedData {
  const data = useContext(ShedDataContext);
  if (!data) throw new Error("Shed data requires a workspace provider");
  return data;
}
