import type {
  ComputerProcess,
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
    error: boolean;
    actions?: ReadonlyMap<string, ProcessAction>;
    refresh?: () => void | Promise<void>;
    stop?: (id: string) => void | Promise<void>;
    start?: (input: ShedProcessCommand) => boolean | Promise<boolean>;
  };
};

/** The workspace owns Query; layout and trays consume its Computer readouts. */
export const ShedDataContext = createContext<ShedData | null>(null);

export function useShedData(): ShedData {
  const data = useContext(ShedDataContext);
  if (!data) throw new Error("Shed data requires a workspace provider");
  return data;
}
