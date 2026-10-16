import { useState } from "react";
import {
  computerList,
  computerReadFile,
  computerWriteFile,
  computerTerminal,
} from "@fungi.computer/agar/computer";
import type { StatusTrayItem } from "@fungi.computer/caps/blocks/status-tray";
import { Button } from "@fungi.computer/caps/components/button";
import { PixelNumber } from "@fungi.computer/caps/components/pixel-number";
import { Status } from "@fungi.computer/caps/components/status";
import type { TerminalState } from "./terminal-panel.js";
import { IconLamps } from "@fungi.computer/caps/components/icon-lamp";
import {
  Display,
  ScreenCell,
  ScreenCells,
  ScreenHeader,
} from "@fungi.computer/caps/components/surface";
import { Sigil } from "@fungi.computer/sigils";
import type { ShedAppConnection } from "./shed-app.js";
import "./computer-instrument.css";

const rights = [
  { id: "list", label: "List files", contract: computerList },
  { id: "read", label: "Read files", contract: computerReadFile },
  { id: "write", label: "Write files", contract: computerWriteFile },
  { id: "run", label: "Run commands", contract: computerTerminal },
] as const;

export type ComputerReading =
  | { kind: "loaded"; count: number }
  | { kind: "loading" | "unavailable" | "error" };

const readingLabels = {
  loading: "Loading",
  unavailable: "Unavailable",
  error: "Refresh failed",
};

/**
 * The Computer access tray: Shed's grants and readings for the window's
 * selected Computer, opened from the shell's status bar. Shed mounts its
 * trays only while a Computer is selected. Lifecycle controls belong to
 * the Host.
 */
export function useComputerAccessTray({
  app,
  terminal = null,
  processes,
  ports,
}: {
  app: ShedAppConnection | null;
  terminal?: { name: string | null; state: TerminalState } | null;
  processes: ComputerReading;
  ports: ComputerReading;
}): StatusTrayItem {
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const requestPermissions = async () => {
    if (!app) return;
    setRequesting(true);
    setRequestError(false);
    try {
      await app.ui.requestAppPermissions({});
    } catch {
      setRequestError(true);
    } finally {
      setRequesting(false);
    }
  };
  return {
    id: "access",
    label: "Access",
    title: "Computer access",
    content: (
      <div className="shed-instrument">
        <Display size="sm">
          <ScreenHeader
            icon={<Sigil name="computer" />}
            title={terminal?.name ?? "Selected Computer"}
            status={
              terminal ? (
                <Status
                  size="compact"
                  label={`Terminal ${terminal.state}`}
                  tone={
                    terminal.state === "open"
                      ? "success"
                      : terminal.state === "failed"
                        ? "error"
                        : "neutral"
                  }
                />
              ) : null
            }
          />
          <ScreenCells>
            <ScreenCell legend="Shed may" wide>
              <IconLamps
                aria-label="Shed may"
                stateLabels={["allowed", "not allowed"]}
                items={rights.map(({ id, label, contract }) => ({
                  id,
                  label,
                  caption: id,
                  icon: <Sigil name={id} />,
                  on: app?.capabilities.has(contract) === true,
                }))}
              />
            </ScreenCell>
            <Reading label="Processes" value={processes} />
            <Reading label="Ports open" value={ports} />
          </ScreenCells>
        </Display>
        {app ? (
          <div className="shed-instrument-keys">
            <Button
              size="sm"
              variant="ghost"
              disabled={requesting}
              onClick={() => void requestPermissions()}
            >
              {requesting ? "Opening permissions…" : "App permissions…"}
            </Button>
          </div>
        ) : null}
        {requestError ? (
          <p role="alert" className="shed-instrument-detail">
            Could not open App permissions. Try again.
          </p>
        ) : null}
      </div>
    ),
  };
}

function Reading({ label, value }: { label: string; value: ComputerReading }) {
  return (
    <ScreenCell legend={label} role="group" aria-label={label}>
      {value.kind === "loaded" ? (
        <PixelNumber value={value.count} pad={2} size="md" />
      ) : (
        <span className="shed-instrument-note">
          {readingLabels[value.kind]}
        </span>
      )}
    </ScreenCell>
  );
}
