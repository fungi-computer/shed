import type { ComputerTerminalInformation } from "@fungi.computer/agar/computer";
import { renderBanner } from "@fungi.computer/lantern/banner";

/** Host labels are plain text; they cannot change terminal state. */
function display(value: string): string {
  return value.replace(/\p{Cc}/gu, " ");
}

/** Join parts with " · ", starting a new row before a part would overflow. */
function pack(parts: readonly string[], cols: number): string {
  const rows: string[] = [];
  let row = "";
  for (const part of parts) {
    const next = row ? `${row} · ${part}` : part;
    if (row && next.length > cols) {
      rows.push(row);
      row = part;
    } else row = next;
  }
  rows.push(row);
  return rows.join("\n");
}

/** Current host facts; configured Teams retain the shared Computer banner. */
export function renderWelcome({
  cols,
  information,
  tty = true,
  noColor = false,
  light = false,
}: {
  cols: number;
  information: ComputerTerminalInformation;
  tty?: boolean;
  noColor?: boolean;
  /** The light prompt follows the banner, so the hint names it. */
  light?: boolean;
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
  // A narrow terminal gets whole facts per row, never one split mid-fact.
  const status = pack(facts, cols);
  // These commands work before a workspace has any files or project tooling.
  // One short row stays intact when the font settles after the initial fit.
  const hint = light
    ? pack(
        ["light shell", "instant", "try: ls", "rg TODO", "jq . package.json"],
        cols,
      )
    : "try: ls · pwd · node -v · exit";
  return `${banner}${status}\n${hint}\n\n`.replace(/\r?\n/g, "\r\n");
}

/** This is client display output, never a command sent to the Computer. */
export function renderConnecting(computer: string): string {
  return `Connecting to ${display(computer)}…\r\n`;
}
