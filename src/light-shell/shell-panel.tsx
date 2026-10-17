import type { AppRoot } from "@fungi.computer/agar";
import { Loader } from "@fungi.computer/caps/components/loader";
import { useCallback, useState, type ReactNode } from "react";
import {
  TerminalPanel,
  type LightShellPort,
  type TerminalState,
  type TerminalStatus,
} from "../terminal-panel.js";
import { runLightCommand } from "./connector.js";

/**
 * Shed's default Computer prompt: one Ghostty terminal with the light shell
 * in front. The same `computer.terminal` session supplies the banner facts
 * and is the escalation target for full commands, so this is a drop-in
 * replacement for `TerminalPanel` wherever Shed mounted it before.
 */
export function ShellPanel({
  app,
  computerId,
  screen,
  onStatusChange,
}: {
  app: Pick<AppRoot, "capabilities">;
  computerId: string;
  screen?: ReactNode;
  onStatusChange?: (status: {
    name: string | null;
    state: TerminalState;
  }) => void;
}) {
  const [terminalState, setTerminalState] = useState<TerminalState>("starting");
  const [hasInformation, setHasInformation] = useState(false);

  const handleTerminalStatus = useCallback(
    (status: TerminalStatus) => {
      onStatusChange?.({ name: status.name, state: status.state });
      setHasInformation(status.information !== null);
      setTerminalState(status.state);
    },
    [onStatusChange],
  );

  const light: LightShellPort = {
    runLight: (input, signal) =>
      runLightCommand(app.capabilities, input, signal),
  };

  // The terminal and its session are still coming up: one Loader. A connect
  // that failed or closed before ever opening shows TerminalPanel's own retry
  // overlay instead of a spinner with no way out.
  const startingScreen =
    screen ??
    (!hasInformation && terminalState === "starting" ? (
      <div className="grid h-full min-h-0 flex-1 place-items-center">
        <Loader size="sm" tone="primary" label="Starting shell" />
      </div>
    ) : undefined);

  return (
    <TerminalPanel
      app={app}
      computerId={computerId}
      screen={startingScreen}
      light={light}
      onStatusChange={handleTerminalStatus}
    />
  );
}
