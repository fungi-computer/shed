import type { ComputerTerminalInformation } from "@fungi.computer/agar/computer";

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

/** Current host facts as plain text; the host adds no art or colour. */
export function renderWelcome({
  cols,
  information,
  light = false,
}: {
  cols: number;
  information: ComputerTerminalInformation;
  /** The light prompt follows the welcome, so the hint names it. */
  light?: boolean;
}): string {
  const hasTeam = information.teamName !== "unconfigured";
  const facts = [display(information.computerName)];
  if (hasTeam) facts.push(`Team ${display(information.teamName)}`);
  // A door named like the Computer repeats it, so only a different name shows.
  if (
    information.modelDoor !== "unconfigured" &&
    information.modelDoor !== information.computerName
  )
    facts.push(`model: ${display(information.modelDoor)}`);
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
  return `${status}\n${hint}\n\n`.replace(/\r?\n/g, "\r\n");
}

/** This is client display output, never a command sent to the Computer. */
export function renderConnecting(computer: string): string {
  return `Connecting to ${display(computer)}…\r\n`;
}
