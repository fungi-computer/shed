import { Sigil } from "@fungi.computer/sigils";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { Button } from "@fungi.computer/caps/components/button";
import type { AppRoot, AppSetup } from "@fungi.computer/agar";
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
  openRuntimeSetup,
  setup,
  openProcesses,
}: {
  app: Pick<AppRoot, "capabilities">;
  setup?: AppSetup | undefined;
  openProcesses?: (() => void) | undefined;
  computerId: string;
  screen?: ReactNode;
  onStatusChange?: (status: {
    name: string | null;
    state: TerminalState;
  }) => void;
  openRuntimeSetup?: () => Promise<"opened" | "unavailable">;
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

  if (setup?.terminal === "exec-only")
    return (
      <EmptyState
        className="m-auto max-w-md p-6"
        visual={<Sigil name="computer" size={48} />}
        title="Run commands in Processes"
        description="This Computer runs commands, but has no interactive terminal."
        actions={
          openProcesses ? (
            <Button onClick={openProcesses}>Open Processes</Button>
          ) : undefined
        }
      />
    );

  return (
    <TerminalPanel
      app={app}
      computerId={computerId}
      screen={startingScreen}
      runtimeMissing={setup?.terminal === "missing"}
      light={light}
      onStatusChange={handleTerminalStatus}
      openRuntimeSetup={openRuntimeSetup}
    />
  );
}
