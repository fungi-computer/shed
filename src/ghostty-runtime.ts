import { Ghostty } from "ghostty-web";

let loaded: Promise<Ghostty> | undefined;

/**
 * Load the Ghostty wasm once. `Ghostty.load()` with no argument uses the
 * wasm embedded in the ghostty-web bundle, so there is no second fetch.
 * `main.tsx` starts it before mounting so compile overlaps the host handshake.
 */
export function loadGhostty(): Promise<Ghostty> {
  loaded ??= Ghostty.load();
  return loaded;
}

/** The faces Ghostty's canvas renderer draws a cell with. */
const terminalFaces = ["", "bold ", "italic ", "bold italic "];

/**
 * Load every face of the terminal font before Ghostty measures its cell.
 * Ghostty sizes rows once, from canvas metrics, when the renderer is created.
 * A canvas never requests a webfont and `document.fonts.ready` does not wait
 * for faces nothing has asked for, so without this the cell is measured
 * against the fallback font and the real font then draws into wrong rows.
 */
export async function loadTerminalFont(
  fontSize: number,
  fontFamily: string,
): Promise<void> {
  await Promise.all(
    terminalFaces.map((face) =>
      document.fonts.load(`${face}${String(fontSize)}px ${fontFamily}`),
    ),
  );
}
