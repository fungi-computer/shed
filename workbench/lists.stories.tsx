import type { ComputerProcess } from "@fungi.computer/agar/computer";
import type { StoryDefault } from "@ladle/react";
import { Button } from "@fungi.computer/caps/components/button";
import { useState } from "react";
import { ShedDataContext } from "../src/shed-data.js";
import { ShedTrays, type ShedPreviewPort } from "../src/shed-trays.js";

export default { title: "Shed / Lists" } satisfies StoryDefault;

const startedAt = Date.UTC(2026, 9, 7, 9, 0, 0);

function process(id: string, command: string): ComputerProcess {
  return {
    port: null,
    id,
    command,
    cwd: "/home/member/garden",
    startedAt,
    state: "running",
    exitCode: null,
    sync: "synced",
    endedAt: null,
  };
}

/**
 * Ports and processes come and go: expose a port, stop one, start or stop a
 * process. Rows arrive, leave and close ranks with the theme's list motion.
 */
export function PortsAndProcesses() {
  const [openId, setOpenId] = useState<string | null>("ports");
  const [ports, setPorts] = useState<readonly ShedPreviewPort[]>([
    previewPort(5173),
  ]);
  const [processes, setProcesses] = useState<readonly ComputerProcess[]>([
    process("p-dev", "pnpm dev"),
    process("p-test", "vitest --watch"),
  ]);
  const expose = (port: number) => {
    setPorts((current) =>
      current.some((item) => item.port === port)
        ? current
        : [...current, previewPort(port)],
    );
    return true;
  };
  const unexpose = (port: number) => {
    setPorts((current) => current.filter((item) => item.port !== port));
  };
  return (
    <div className="grid h-dvh min-h-[560px] grid-rows-[auto_1fr_1fr] gap-md p-md font-sans">
      <div className="flex flex-wrap gap-sm">
        <Button
          data-list-demo="expose"
          size="sm"
          variant="outline"
          onClick={() => {
            expose(3000);
            expose(8080);
          }}
        >
          Expose 3000 and 8080
        </Button>
        <Button
          data-list-demo="unexpose"
          size="sm"
          variant="outline"
          onClick={() => {
            unexpose(3000);
          }}
        >
          Stop 3000
        </Button>
        <Button
          data-list-demo="start"
          size="sm"
          variant="outline"
          onClick={() => {
            setProcesses((current) => [
              process("p-docs", "pnpm docs:serve"),
              ...current,
            ]);
          }}
        >
          Start docs
        </Button>
        <Button
          data-list-demo="stop"
          size="sm"
          variant="outline"
          onClick={() => {
            setProcesses((current) =>
              current.filter((item) => item.id !== "p-dev"),
            );
          }}
        >
          Stop pnpm dev
        </Button>
      </div>
      <div className="self-end">
        <ShedDataContext.Provider
          value={{
            ports: { items: ports, status: "loaded", expose, unexpose },
            processes: {
              items: processes,
              loading: false,
              error: false,
              stop: (id) => {
                setProcesses((current) =>
                  current.filter((item) => item.id !== id),
                );
              },
            },
          }}
        >
          <ShedTrays
            openPreview={() => undefined}
            openId={openId}
            onOpenChange={setOpenId}
            leading="Local list fixture"
          />
        </ShedDataContext.Provider>
      </div>
    </div>
  );
}

function previewPort(port: number): ShedPreviewPort {
  return {
    port,
    previewUrl: `https://preview.example.test/${String(port)}`,
    openMode: "inline" as const,
    expiresAt: startedAt + 300000,
  };
}
