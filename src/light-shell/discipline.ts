import {
  completeShellCommand,
  prepareShellPrompt,
  type ShellRoute,
} from "./shell-route.js";
import { maximumCommandCharacters } from "@fungi.computer/computer-contract";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { LightRunInput, LightRunResult } from "./connector.js";
import { CommandHistory } from "./history.js";
import { editLine, editLineKey, type LineState } from "./line-editor.js";

/**
 * The light shell's line discipline: a deterministic state machine from key
 * and text events to terminal bytes plus one effect for the owner to carry
 * out. It owns the line, history, completion and reverse search; it never
 * touches the DOM, the terminal or the network.
 *
 * Chunks marked `record` are committed output (submitted lines, command
 * output). The owner keeps those for theme and resize replays. Unrecorded
 * chunks are the live prompt, which the owner repaints with `draw()` after a
 * replay.
 */

export type KeyInput = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "isComposing"
>;
export type Chunk = Readonly<{ text: string; record: boolean }>;
export type Effect =
  | Readonly<{ kind: "none" | "interrupt" | "clear" | "exit" }>
  | Readonly<{ kind: "run" | "escalate"; request: LightRunInput }>;
export type Step = Readonly<{
  /** False leaves the key with Ghostty's ordinary handling. */
  consumed: boolean;
  chunks: readonly Chunk[];
  effect: Effect;
  /** Plain text of the rows committed by this step, for assistive tech. */
  log: string;
}>;
export type Phase = "idle" | "busy" | "full" | "closed";

const ESC = "\x1b";
// A light command has no TTY and no use for terminal modes. DECSTR resets the
// soft modes, and mouse and bracketed paste are switched off explicitly. Ghostty
// homes the cursor on `?1049l` and `?6l`, so screen switches are removed from
// the output instead of being reset afterwards.
const MODE_RESET = `${ESC}[!p${ESC}[?1000l${ESC}[?1002l${ESC}[?1003l${ESC}[?1006l${ESC}[?2004l`;
const SCREEN_SWITCHES = ["1049", "1047", "47", "6"].flatMap((mode) => [
  `${ESC}[?${mode}h`,
  `${ESC}[?${mode}l`,
]);
function withoutScreenSwitches(output: string): string {
  return SCREEN_SWITCHES.reduce(
    (text, sequence) => text.split(sequence).join(""),
    output,
  );
}
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const CLEAR_SCREEN = `${ESC}[2J${ESC}[3J${ESC}[H`;
/** One prompt row as terminal bytes and as plain text. */
type Row = Readonly<{ ansi: string; plain: string }>;
const NONE: Effect = { kind: "none" };
const IGNORED: Step = { consumed: false, chunks: [], effect: NONE, log: "" };

const paint = (code: string, text: string): string =>
  `${ESC}[${code}m${text}${ESC}[0m`;
const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");
const live = (text: string): Chunk => ({ text, record: false });
const committed = (text: string): Chunk => ({ text, record: true });

function position(width: number, columns: number) {
  return { row: Math.floor(width / columns), col: width % columns };
}

export class LightDiscipline {
  #history = new CommandHistory();
  #line: LineState = { text: "", cursor: 0 };
  #search: string | null = null;
  #phase: Phase = "idle";
  #completionPrefix: string | null = null;
  #cwd = "/workspace";
  #env: Readonly<Record<string, string>> = {};
  #exitCode = 0;
  #cursorRow = 0;
  #columns: number;
  #fullReady = false;
  readonly #computerName: string;

  constructor({
    computerName,
    columns,
  }: {
    computerName: string;
    columns: number;
  }) {
    this.#computerName = computerName;
    this.#columns = Math.max(2, columns);
  }

  get phase(): Phase {
    return this.#phase;
  }
  get route(): ShellRoute {
    const prompt = prepareShellPrompt(this.#line.text);
    if (prompt.kind === "command") return prompt.route;
    if (prompt.kind === "invalid")
      return { where: "invalid", message: prompt.message };
    return { where: "light" };
  }

  setColumns(columns: number): void {
    this.#columns = Math.max(2, columns);
  }

  /** Whether the full shell session is open and can take a command now. */
  setFullReady(ready: boolean): void {
    this.#fullReady = ready;
  }

  /** The live prompt at the cursor, which must be at the start of a row. */
  draw(): Chunk {
    this.#cursorRow = 0;
    return live(this.#paint(true));
  }

  /** Repaint the live prompt in place. */
  redraw(): Chunk {
    return live(this.#erase() + this.#paint(true));
  }

  /** The person left the full shell (bash `exit`): the light prompt returns. */
  returnFromFull(): Step {
    this.#phase = "idle";
    return this.#step([committed("\r\n"), this.draw()]);
  }

  /** Leave the closed state after `exit`. */
  reopen(): Step {
    this.#phase = "idle";
    return this.#step([this.draw()]);
  }

  key(event: KeyInput): Step {
    if (event.isComposing || this.#phase === "full") return IGNORED;
    if (this.#phase === "closed") return this.#swallow();
    const ctrl = event.ctrlKey && !event.altKey && !event.metaKey;
    const letter = ctrl ? event.key.toLowerCase() : "";
    if (ctrl && !event.shiftKey && letter === "c") return this.#interrupt();
    if (this.#phase === "busy") return this.#swallow();
    if (this.#search !== null) return this.#searchKey(event, letter);
    if (event.altKey || event.metaKey) return IGNORED;
    if (ctrl) {
      if (letter === "r") {
        this.#search = "";
        return this.#repaint();
      }
      if (letter === "l") {
        this.#cursorRow = 0;
        return this.#step([live(CLEAR_SCREEN), this.draw()], { kind: "clear" });
      }
    } else if (!event.shiftKey) {
      switch (event.key) {
        case "Enter":
          return this.#submit();
        case "Tab":
          return this.#tab();
        case "ArrowUp":
          return this.#recall(this.#history.previous(this.#line.text));
        case "ArrowDown":
          return this.#recall(this.#history.next());
        case "ArrowRight": {
          const suggestion = this.#suggestion();
          if (suggestion) {
            this.#completionPrefix = null;
            this.#line = editLine(this.#line, {
              type: "insert",
              text: suggestion,
            });
            return this.#repaint();
          }
          break;
        }
        default:
          break;
      }
    }
    if (event.shiftKey && !ctrl) return IGNORED;
    const edited = editLineKey(this.#line, event);
    if (!edited) return IGNORED;
    this.#completionPrefix = null;
    this.#line = edited;
    return this.#repaint();
  }

  /**
   * Printable text, IME commits and paste. Control input is never accepted.
   * A paste of several lines is refused rather than run or joined: the light
   * shell takes one command at a time.
   */
  input(data: string): Step {
    if (this.#phase !== "idle") return this.#swallow();
    // A full shell that ended without leaving bracketed paste (2004) makes
    // Ghostty wrap pastes; the payload is still pasted text.
    const pasted =
      data.startsWith(BRACKETED_PASTE_START) &&
      data.endsWith(BRACKETED_PASTE_END)
        ? data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length)
        : data;
    if (pasted.startsWith(ESC)) return this.#swallow();
    const lines = pasted.replace(/[\r\n]+$/, "");
    if (/[\r\n]/.test(lines))
      return this.#listing(
        "The light shell runs one line at a time; paste several lines into the full shell (full bash).",
      );
    const text = lines.replace(/\p{Cc}/gu, "");
    if (text.length === 0) return this.#swallow();
    if (this.#search !== null) {
      this.#search += text;
      return this.#repaint();
    }
    const room = maximumCommandCharacters - this.#line.text.length;
    if (room <= 0) return this.#swallow();
    this.#completionPrefix = null;
    this.#line = editLine(this.#line, {
      type: "insert",
      text: text.slice(0, room),
    });
    return this.#repaint();
  }

  /** The light command finished. The owner drops results it has aborted. */
  finish(result: LightRunResult): Step {
    this.#phase = "idle";
    this.#cwd = result.cwd;
    this.#env = result.env;
    this.#exitCode = result.exitCode;
    const output = withoutScreenSwitches(result.stdout + result.stderr);
    const hint =
      result.exitCode === 127
        ? "light: command not found; use full to run it in the full shell."
        : "";
    const rows = [output.replace(/\r?\n$/, ""), hint].filter(
      (row) => row.length > 0,
    );
    const text = rows.map((row) => `${crlf(row)}\r\n`).join("");
    return this.#step(
      [committed(text + MODE_RESET), this.draw()],
      NONE,
      stripAnsi(rows.join("\n")),
    );
  }

  /** The light command or the full shell could not start. */
  fail(kind: "light" | "full"): Step {
    this.#phase = "idle";
    const message =
      kind === "full"
        ? "The full shell could not start. Light commands still work."
        : "The light shell could not run this command.";
    return this.#step(
      [committed(`${message}\r\n`), this.draw()],
      NONE,
      message,
    );
  }

  #swallow(): Step {
    return { consumed: true, chunks: [], effect: NONE, log: "" };
  }

  #step(chunks: readonly Chunk[], effect: Effect = NONE, log = ""): Step {
    return { consumed: true, chunks, effect, log };
  }

  #repaint(): Step {
    return this.#step([this.redraw()]);
  }

  #recall(text: string | null): Step {
    if (text !== null) {
      this.#completionPrefix = null;
      this.#line = { text, cursor: text.length };
    }
    return this.#repaint();
  }

  #suggestion(): string | null {
    return this.#line.cursor === this.#line.text.length
      ? this.#history.suggest(this.#line.text)
      : null;
  }

  #interrupt(): Step {
    const wasBusy = this.#phase === "busy";
    this.#phase = "idle";
    this.#search = null;
    this.#completionPrefix = null;
    // A running command already committed its prompt row; ^C goes under it.
    if (wasBusy)
      return this.#step(
        [committed("^C\r\n"), this.draw()],
        { kind: "interrupt" },
        "^C",
      );
    const row = this.#plainRow();
    this.#line = { text: "", cursor: 0 };
    return this.#step(
      [live(this.#erase()), committed(`${row.ansi}^C\r\n`), this.draw()],
      NONE,
      `${row.plain}^C`,
    );
  }

  #searchKey(event: KeyInput, letter: string): Step {
    const query = this.#search ?? "";
    if (event.key === "Escape") {
      this.#search = null;
      return this.#repaint();
    }
    if (event.key === "Enter" || (letter === "r" && !event.shiftKey)) {
      const match = this.#history.search(query, this.#line.text);
      if (match !== null) this.#line = { text: match, cursor: match.length };
      if (event.key === "Enter") this.#search = null;
      return this.#repaint();
    }
    if (event.key === "Backspace") {
      this.#search = editLine(
        { text: query, cursor: query.length },
        { type: "backspace" },
      ).text;
      return this.#repaint();
    }
    return this.#swallow();
  }

  #tab(): Step {
    const { text, cursor } = this.#line;
    if (cursor !== text.length) return this.#swallow();
    const completions = completeShellCommand(text);
    if (completions === null) return this.#swallow();
    if ("kind" in completions) return this.#listing(completions.message);
    if (completions.length === 1) {
      this.#completionPrefix = null;
      return this.#recall(`${completions[0].name} `);
    }
    if (this.#completionPrefix !== text) {
      this.#completionPrefix = text;
      return this.#swallow();
    }
    this.#completionPrefix = null;
    return this.#listing(
      completions
        .map((item) => `${item.name}${item.where === "full" ? " ⚡" : ""}`)
        .join(" · "),
    );
  }

  /** Keep the prompt as typed, print rows under it, then prompt again. */
  #listing(message: string): Step {
    const row = this.#plainRow();
    return this.#step(
      [
        live(this.#erase()),
        committed(`${row.ansi}\r\n${crlf(message)}\r\n`),
        this.draw(),
      ],
      NONE,
      `${row.plain}\n${message}`,
    );
  }

  #submit(): Step {
    const { text } = this.#line;
    const row = this.#plainRow();
    const erase = live(this.#erase());
    if (text.trim().length === 0) {
      return this.#step([erase, committed(`${row.ansi}\r\n`), this.draw()]);
    }
    const prompt = prepareShellPrompt(text);
    if (prompt.kind !== "command" && prompt.kind !== "invalid") {
      this.#line = { text: "", cursor: 0 };
      if (prompt.kind === "light") {
        const message = "Already in the light shell.";
        return this.#step(
          [erase, committed(`${row.ansi}\r\n${message}\r\n`), this.draw()],
          NONE,
          `${row.plain}\n${message}`,
        );
      }
      this.#history = new CommandHistory();
      this.#phase = "closed";
      return this.#step(
        [erase, committed(`${row.ansi}\r\n`)],
        { kind: "exit" },
        row.plain,
      );
    }
    const route: ShellRoute =
      prompt.kind === "command"
        ? prompt.route
        : { where: "invalid", message: prompt.message };
    if (route.where === "invalid") {
      return this.#step(
        [
          erase,
          committed(`${row.ansi}\r\n${crlf(route.message)}\r\n`),
          this.draw(),
        ],
        NONE,
        `${row.plain}\n${route.message}`,
      );
    }
    this.#history.record(text);
    this.#line = { text: "", cursor: 0 };
    const command = prompt.kind === "command" ? prompt.command : text;
    const request = {
      command,
      cwd: this.#cwd,
      env: this.#env,
    };
    if (route.where === "full") {
      this.#phase = "full";
      // With a session open the shell's own prompt replaces this one in place,
      // so the command is not shown twice.
      if (this.#fullReady)
        return this.#step([erase], { kind: "escalate", request }, row.plain);
      const message = `Starting the full shell for ${command}…`;
      return this.#step(
        [erase, committed(`${row.ansi}\r\n${message}\r\n`)],
        { kind: "escalate", request },
        `${row.plain}\n${message}`,
      );
    }
    this.#phase = "busy";
    return this.#step(
      [erase, committed(`${row.ansi}\r\n`)],
      { kind: "run", request },
      row.plain,
    );
  }

  #erase(): string {
    const up = this.#cursorRow > 0 ? `${ESC}[${String(this.#cursorRow)}A` : "";
    this.#cursorRow = 0;
    return `${up}\r${ESC}[J`;
  }

  #head(): Row {
    const mark = this.#exitCode === 0 ? "✓" : `✗ ${String(this.#exitCode)}`;
    const where = ` fungi@${this.#computerName} ${this.#cwd} `;
    return {
      ansi: `${paint(this.#exitCode === 0 ? "32" : "31", mark)}${where}${paint("36", "◦light")} ➜ `,
      plain: `${mark}${where}◦light ➜ `,
    };
  }

  /** The submitted prompt line as plain scrollback: no route colour, no ghost. */
  #plainRow(): Row {
    const head = this.#head();
    return {
      ansi: head.ansi + this.#line.text,
      plain: head.plain + this.#line.text,
    };
  }

  #paint(withCursor: boolean): string {
    const columns = this.#columns;
    const { text, cursor } = this.#line;
    let head: Row;
    let body: string;
    let ghost = "";
    if (this.#search !== null) {
      const label = `(reverse-i-search)'${this.#search}': `;
      head = { ansi: paint("2", label), plain: label };
      body = text;
    } else {
      head = this.#head();
      const route = this.route;
      const colour =
        route.where === "invalid"
          ? "31;4:3"
          : route.where === "full"
            ? "33"
            : "32";
      body = text.length > 0 ? paint(colour, text) : "";
      ghost = this.#suggestion() ?? "";
    }
    const headWidth = stringWidth(head.plain);
    const end = headWidth + stringWidth(text) + stringWidth(ghost);
    const at = headWidth + stringWidth(text.slice(0, cursor));
    let out = head.ansi + body + (ghost ? paint("2", ghost) : "");
    // A row filled exactly leaves the cursor pending a wrap; force it.
    if (end > 0 && end % columns === 0) out += " \r";
    const from = position(end, columns);
    const to = position(at, columns);
    if (withCursor) {
      if (from.row > to.row) out += `${ESC}[${String(from.row - to.row)}A`;
      out += `${ESC}[${String(to.col + 1)}G`;
    }
    this.#cursorRow = to.row;
    return out;
  }
}
