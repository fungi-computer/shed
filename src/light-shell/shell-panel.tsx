import type { AppRoot } from "@fungi.computer/agar";
import type { ComputerTerminalInformation } from "@fungi.computer/agar/computer";
import { Loader } from "@fungi.computer/caps/components/loader";
import { useCallback, useState, type ReactNode } from "react";
import {
  TerminalPanel,
  type TerminalState,
  type TerminalStatus,
} from "../terminal-panel.js";
import { LightShellPanel, type LightRunInput } from "./panel.js";
import { runLightCommand } from "./connector.js";

/**
 * Shed's default Computer prompt: the light shell in front, the existing
 * full terminal behind it. The same `computer.terminal` session backs both —
 * it supplies the banner facts the light prompt shows and is the escalation
 * target — so this is a drop-in replacement for `TerminalPanel` wherever Shed
 * mounted it before.
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
  const [information, setInformation] =
    useState<ComputerTerminalInformation | null>(null);
  const [terminalState, setTerminalState] = useState<TerminalState>("starting");
  const [escalated, setEscalated] = useState(false);
  const [run, setRun] = useState<string | null>(null);

  const handleTerminalStatus = useCallback(
    (status: TerminalStatus) => {
      onStatusChange?.({ name: status.name, state: status.state });
      setInformation(status.information);
      setTerminalState(status.state);
      // A session the person ended (typing `exit` in the real shell) hands
      // the prompt back to the light shell; a failed connect keeps showing
      // the full panel's own retry affordance instead of hiding the error.
      if (status.state === "closed" && escalated) {
        setEscalated(false);
        setRun(null);
      }
    },
    [onStatusChange, escalated],
  );

  const runLight = useCallback(
    (input: LightRunInput, signal: AbortSignal) =>
      runLightCommand(app.capabilities, input, signal),
    [app],
  );

  const openFull = useCallback((input: LightRunInput) => {
    setRun(input.command);
    setEscalated(true);
    return Promise.resolve();
  }, []);

  // No information yet covers two different moments: still connecting (show
  // the light shell's own loader) and never connected at all — failed or
  // closed before ever opening (undefined, so TerminalPanel's own retry
  // overlay shows instead of a spinner with no way out).
  const lightScreen =
    screen ??
    (escalated ? undefined : information !== null ? (
      <LightShellPanel
        key={computerId}
        information={information}
        runLight={runLight}
        openFull={openFull}
      />
    ) : terminalState === "starting" ? (
      <div className="grid h-full min-h-0 flex-1 place-items-center">
        <Loader size="sm" tone="primary" label="Connecting" />
      </div>
    ) : undefined);

  return (
    <TerminalPanel
      app={app}
      computerId={computerId}
      screen={lightScreen}
      run={escalated ? run : null}
      onStatusChange={handleTerminalStatus}
    />
  );
}
