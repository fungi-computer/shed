import { ShellPanel } from "../src/light-shell/shell-panel.js";
import type { StoryDefault } from "@ladle/react";
import { Button } from "@fungi.computer/caps/components/button";
import type { ComputerProcess } from "@fungi.computer/agar/computer";
import { useState } from "react";
import { NoTeamComputersState, ShedWorkspaceView } from "../src/shed-app.js";
import { ShedDataContext } from "../src/shed-data.js";
import { createShedFixture } from "./fixtures.js";

export default { title: "Shed" } satisfies StoryDefault;

const liveProcesses: readonly ComputerProcess[] = [
  {
    port: null,
    id: "proc-dev",
    command: "pnpm dev",
    cwd: "/workspace/field-notes",
    startedAt: 1,
    state: "running",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  },
  {
    port: null,
    id: "proc-server",
    command: "node server.js",
    cwd: "/workspace/field-notes",
    startedAt: 2,
    state: "running",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  },
];

function Workbench({
  selected = true,
  terminal = true,
  narrow = false,
  tile = false,
  live = false,
  terminalState = "open",
}: {
  selected?: boolean;
  terminal?: boolean;
  narrow?: boolean;
  tile?: boolean;
  live?: boolean;
  terminalState?: NonNullable<
    Parameters<typeof createShedFixture>[0]
  >["terminalState"];
}) {
  const [ports, setPorts] = useState(() =>
    selected
      ? [
          {
            port: 5173,
            previewUrl: "https://member.preview.example.test/",
            openMode: "inline" as const,
            expiresAt: Date.now() + 300_000,
          },
          {
            port: 8787,
            previewUrl: "https://member.preview.example.test/",
            openMode: "inline" as const,
            expiresAt: Date.now() + 300_000,
          },
        ].slice(0, live ? 2 : 1)
      : null,
  );
  const [processes, setProcesses] = useState(() => liveProcesses);
  const [fixture] = useState(() =>
    createShedFixture({ selected, terminal, terminalState }),
  );
  const [computerId, setComputerId] = useState<string | null>(
    selected ? "Workbench" : null,
  );
  const selectComputer = (next: string | null) => {
    fixture.selectComputer(next);
    setComputerId(next);
  };
  return (
    <div
      className={
        tile
          ? "flex h-[400px] w-[560px] min-h-0 flex-col"
          : "flex h-dvh min-h-[560px] flex-col gap-2 p-2 font-sans"
      }
    >
      {!tile && (
        <div className="flex items-center justify-between gap-4 text-xs text-base-content/60">
          <span>
            Real Shed UI · local Computer fixture · terminal input echoes; no
            commands run
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              selectComputer(computerId ? null : "Workbench");
            }}
          >
            {computerId ? "Clear Computer" : "Select Workbench"}
          </Button>
        </div>
      )}
      <div
        className={
          narrow
            ? "min-h-0 w-full max-w-[460px] flex-1 self-center"
            : "min-h-0 flex-1"
        }
      >
        <ShedDataContext.Provider
          value={{
            ports: {
              status:
                computerId === null || !selected ? "unavailable" : "loaded",
              items: ports,
              unexpose: live
                ? (port) => {
                    setPorts(
                      (current) =>
                        current?.filter((item) => item.port !== port) ?? null,
                    );
                    return Promise.resolve();
                  }
                : undefined,
            },
            processes: {
              items: live ? processes : null,
              loading: false,
              error: false,
              stop: live
                ? (id) => {
                    setProcesses((current) =>
                      current.map((process) =>
                        process.id === id
                          ? {
                              ...process,
                              state: "exited",
                              exitCode: 143,
                              endedAt: 3,
                            }
                          : process,
                      ),
                    );
                    return Promise.resolve();
                  }
                : undefined,
            },
          }}
        >
          <ShedWorkspaceView app={fixture.app} computerId={computerId} />
        </ShedDataContext.Provider>
      </div>
    </div>
  );
}

export const Workspace = () => <Workbench />;
export const ExposedPorts = () => <Workbench />;
/** Stop a port with an undo window or hold to stop a process. */
export const LiveStops = () => <Workbench live />;
export const Tile = () => <Workbench tile />;
export const Narrow = () => <Workbench narrow />;
export const NoComputer = () => (
  <div className="h-dvh w-full">
    <NoTeamComputersState onAllowAccess={() => undefined} />
  </div>
);
export const TerminalUnavailable = () => <Workbench terminal={false} />;

export const TerminalConnecting = () => (
  <Workbench terminalState="connecting" />
);
export const TerminalFailed = () => <Workbench terminalState="failed" />;
export const TerminalClosed = () => <Workbench terminalState="closed" />;

/** Controlled presentation ports: canned command output, no Computer. */
export const Light = () => {
  const fixture = createShedFixture();
  return (
    <div className="flex h-dvh min-h-[560px] flex-col gap-2 p-2">
      <p className="text-xs text-base-content/60">
        Light shell · local visual fixture · canned output, no Computer
      </p>
      <ShellPanel app={fixture.app} computerId="Workbench" />
    </div>
  );
};
