import type { ComputerTerminalInformation } from "@fungi.computer/agar/computer";
import { renderBanner } from "@fungi.computer/lantern/banner";

/** Host labels are plain text; they cannot change terminal state. */
function display(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

/** Current host facts; configured Teams retain the shared Computer banner. */
export function renderWelcome({
  cols,
  information,
  tty = true,
  noColor = false,
}: {
  cols: number;
  information: ComputerTerminalInformation;
  tty?: boolean;
  noColor?: boolean;
}): string {
  const hasTeam = information.teamName !== "unconfigured";
  const banner = hasTeam
    ? renderBanner({
        brand: "computer",
        columns: cols,
        interactive: tty,
        noColor,
        rawPty: true,
      })
    : "";
  const facts = [display(information.computerName)];
  if (hasTeam) facts.push(`Team ${display(information.teamName)}`);
  if (information.modelDoor !== "unconfigured")
    facts.push(`model door: ${display(information.modelDoor)}`);
  facts.push(`up ${String(Math.floor(information.uptimeSeconds / 60))}m`);
  if (information.version !== "0.0.0")
    facts.push(
      `${hasTeam ? "Fungi" : "Computer"} ${display(information.version)}`,
    );
  const row = facts.join(" · ");
  const status = row.length <= cols ? row : facts.join("\n");
  // These commands work before a workspace has any files or project tooling.
  // One short row stays intact when the font settles after the initial fit.
  const hint = "try: ls · pwd · node -v · exit";
  return `${banner}${status}\n${hint}\n\n`.replace(/\r?\n/g, "\r\n");
}

/** This is client display output, never a command sent to the Computer. */
export function renderConnecting(computer: string): string {
  return `Connecting to ${display(computer)}…\r\n`;
}
