import type { StoryDefault } from "@ladle/react";
import type {
  ComputerProcess,
  ComputerPorts,
} from "@fungi.computer/agar/computer";
import { useState } from "react";

import type { ProcessAction } from "../src/shed-processes.js";
import type { PortAction } from "../src/shed-ports.js";
import { ShedWorkspaceView } from "../src/shed-app.js";
import { ShedTrays } from "../src/shed-trays.js";
import { ShedDataContext } from "../src/shed-data.js";
import { createShedFixture } from "./fixtures.js";

export default { title: "Shed" } satisfies StoryDefault;

const previewUrl = new URL("./preview.html", import.meta.url).href;
const makePort = (port: number) => ({
  port,
  previewUrl,
  openMode: "inline" as const,
  expiresAt: Date.now() + 300_000,
});
const portSets = {
  one: [makePort(5173)],
  several: [makePort(5173), makePort(3000), makePort(8787)],
  empty: [],
} satisfies Record<string, ComputerPorts["ports"]>;
const now = Date.now();
const processRows: readonly ComputerProcess[] = [
  {
    port: null,
    id: "proc-7f3a",
    command: "pnpm dev --host 0.0.0.0",
    cwd: "/workspace/site",
    startedAt: now - 600_000,
    state: "running",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  },
  {
    port: null,
    id: "proc-91c2",
    command: "node server.mjs",
    cwd: "/workspace/api",
    startedAt: now - 300_000,
    state: "running",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  },
  {
    port: null,
    id: "proc-0b11",
    command: "pnpm test --watch",
    cwd: "/workspace/site",
    startedAt: now - 900_000,
    state: "exited",
    exitCode: 1,
    sync: "synced",
    endedAt: now - 60_000,
  },
  {
    port: null,
    id: "proc-22aa",
    command: "python -m http.server 8000",
    cwd: "/workspace/docs",
    startedAt: now - 1_200_000,
    state: "uncertain",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  },
  {
    port: null,
    id: "proc-5e9d",
    command: "git clone https://example.test/repo.git .",
    cwd: "/workspace/clone",
    startedAt: now - 30_000,
    state: "exited",
    exitCode: 0,
    sync: "pending",
    endedAt: now - 5_000,
  },
];

function Cap({
  ports,
  portStatus = "loaded",
  processes = null,
  processLoading = false,
  processError = false,
  processActions,
  portActions,
  portsLoading = false,
}: {
  ports: ComputerPorts["ports"];
  portStatus?: "loaded" | "error" | "not-configured";
  processes?: readonly ComputerProcess[] | null;
  processLoading?: boolean;
  processError?: boolean;
  processActions?: ReadonlyMap<string, ProcessAction>;
  portActions?: ReadonlyMap<number, PortAction>;
  portsLoading?: boolean;
}) {
  const [fixture] = useState(() =>
    createShedFixture({ selected: true, terminal: true }),
  );
  const [shownPorts, setShownPorts] = useState(ports);
  const [shownProcesses, setShownProcesses] = useState(processes);
  const expose = (port: number) => {
    setShownPorts((current) =>
      current.some((item) => item.port === port)
        ? current
        : [...current, makePort(port)],
    );
    return true;
  };
  const unexpose = (port: number) => {
    setShownPorts((current) => current.filter((item) => item.port !== port));
  };
  const stopProcess = (id: string) => {
    setShownProcesses(
      (current) =>
        current?.map((process) =>
          process.id === id
            ? {
                ...process,
                state: "exited",
                exitCode: 143,
                endedAt: Date.now(),
              }
            : process,
        ) ?? null,
    );
  };
  return (
    <div className="h-dvh w-full">
      <ShedDataContext.Provider
        value={{
          ports: {
            items: portsLoading ? null : shownPorts,
            status: portsLoading ? "loading" : portStatus,
            actions: portActions,
            refresh: () => undefined,
            expose,
            unexpose,
          },
          processes: {
            items: shownProcesses,
            loading: processLoading,
            error: processError,
            actions: processActions,
            refresh: () => undefined,
            stop: stopProcess,
          },
        }}
      >
        <ShedWorkspaceView
          app={fixture.app}
          computerId="Workbench"
          computerAccessGranted
        />
      </ShedDataContext.Provider>
    </div>
  );
}

export const CapEmpty = () => <Cap ports={portSets.empty} />;
export const CapOnePort = () => <Cap ports={portSets.one} />;
export const CapPortExposing = () => (
  <Cap
    ports={[makePort(3000)]}
    portActions={new Map([[5173, { expose: true, status: "pending" }]])}
  />
);
export const CapPortExposeFailed = () => (
  <Cap
    ports={[makePort(3000)]}
    portActions={new Map([[5173, { expose: true, status: "failed" }]])}
  />
);
export const CapPortRemoving = () => (
  <Cap
    ports={portSets.several}
    portActions={new Map([[3000, { expose: false, status: "pending" }]])}
  />
);
export const CapPortRemoveFailed = () => (
  <Cap
    ports={portSets.several}
    portActions={new Map([[3000, { expose: false, status: "failed" }]])}
  />
);
export const CapSeveralPorts = () => (
  <Cap ports={portSets.several} processes={processRows} />
);
export const CapProcessesUnavailable = () => <Cap ports={portSets.one} />;
export const CapProcessesListed = () => (
  <Cap ports={portSets.one} processes={processRows} />
);
/** The Processes tray held open, for a stable "files not synced yet" shot. */
export const CapProcessesOpenPendingSync = () => (
  <div className="h-dvh w-full p-4">
    <ShedDataContext.Provider
      value={{
        ports: { items: [], status: "loaded", refresh: () => undefined },
        processes: {
          items: processRows,
          loading: false,
          error: false,
          refresh: () => undefined,
        },
      }}
    >
      <ShedTrays
        placement="housing"
        openPreview={() => undefined}
        openId="processes"
        onOpenChange={() => undefined}
      />
    </ShedDataContext.Provider>
  </div>
);
export const CapProcessesLoading = () => (
  <Cap ports={portSets.one} processLoading />
);
export const CapProcessesError = () => (
  <Cap ports={portSets.one} processError />
);
export const CapPortsLoading = () => <Cap ports={[]} portsLoading />;
export const CapPortsNotConfigured = () => (
  <Cap ports={portSets.empty} portStatus="not-configured" />
);
export const CapPortsError = () => (
  <Cap ports={portSets.empty} portStatus="error" />
);

export const CapProcessesStopping = () => (
  <Cap
    ports={portSets.one}
    processes={processRows}
    processActions={new Map([["proc-7f3a", "stopping"]])}
  />
);
export const CapProcessStopFailed = () => (
  <Cap
    ports={portSets.one}
    processes={processRows}
    processActions={new Map([["proc-7f3a", "failed"]])}
  />
);
