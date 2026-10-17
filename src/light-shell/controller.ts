import type { ShellRoute } from "@fungi.computer/computer/light-shell";
import { reportCatchFailure } from "../failure.js";
import type { LightRunInput, LightRunResult } from "./connector.js";
import {
  LightDiscipline,
  type KeyInput,
  type Phase,
  type Step,
} from "./discipline.js";

const BUSY_DELAY_MS = 300;
const MAX_HELD_BYTES = 256 * 1024;

export type LightView = Readonly<{
  phase: Phase;
  route: ShellRoute["where"];
  /** Spoken when the route changes, never on every key. */
  routeLabel: string;
  /** A command has been running long enough to show the busy indicator. */
  busy: boolean;
}>;

/** What the controller needs from the terminal surface and the PTY session. */
export type LightPorts = Readonly<{
  /** Write the live prompt, which is never kept for replays. */
  live: (text: string) => void;
  /** Write committed output (or PTY bytes) and keep it for replays. */
  commit: (bytes: Uint8Array) => void;
  /** Drop the committed output (Ctrl+L). */
  forget: () => void;
  /** Type into the full shell; rejects when no session is open. */
  send: (text: string) => Promise<void>;
  /** Open the full shell session if it is not open; resolves once it is. */
  connect: () => Promise<void>;
  runLight: (
    input: LightRunInput,
    signal: AbortSignal,
  ) => Promise<LightRunResult>;
  view: (view: LightView) => void;
  /** Plain rows just committed, for the screen-reader log. */
  log: (text: string) => void;
}>;

/**
 * One Ghostty surface, two input owners. In light mode the line discipline
 * owns the keys and the PTY's bytes are held back; in full mode the PTY owns
 * both. A full command swaps the owner in place on the same canvas; the
 * shell ending (`exit`) swaps it back.
 */
export class LightController {
  readonly #ports: LightPorts;
  readonly #discipline: LightDiscipline;
  #mode: "light" | "full" = "light";
  #held: Uint8Array[] = [];
  #heldBytes = 0;
  #sessionOpen = false;
  #abort: AbortController | null = null;
  #busyTimer: ReturnType<typeof setTimeout> | undefined;
  #busy = false;
  #disposed = false;
  readonly #encoder = new TextEncoder();

  constructor(
    ports: LightPorts,
    { computerName, columns }: { computerName: string; columns: number },
  ) {
    this.#ports = ports;
    this.#discipline = new LightDiscipline({ computerName, columns });
  }

  /** Draw the first prompt, after the banner. */
  start(): void {
    this.#ports.live(this.#discipline.draw().text);
    this.#publish();
  }

  /** The surface was rebuilt and replayed its committed output: prompt again. */
  repaint(columns: number): void {
    this.#discipline.setColumns(columns);
    if (this.#mode === "light" && this.#discipline.phase === "idle")
      this.#ports.live(this.#discipline.draw().text);
  }

  setColumns(columns: number): void {
    this.#discipline.setColumns(columns);
  }

  setSessionOpen(open: boolean): void {
    this.#sessionOpen = open;
    this.#discipline.setFullReady(open);
  }

  /** True when the key was consumed and must not reach Ghostty's encoder. */
  key(event: KeyInput): boolean {
    if (this.#mode !== "light") return false;
    const step = this.#discipline.key(event);
    this.#apply(step);
    return step.consumed;
  }

  /** Text from Ghostty. Returns false in full mode, where the PTY owns it. */
  input(data: string): boolean {
    if (this.#mode !== "light") return false;
    this.#apply(this.#discipline.input(data));
    return true;
  }

  /** Bytes from the PTY. */
  output(bytes: Uint8Array): void {
    if (this.#mode === "full") {
      this.#ports.commit(bytes);
      return;
    }
    this.#held.push(bytes);
    this.#heldBytes += bytes.byteLength;
    while (this.#heldBytes > MAX_HELD_BYTES && this.#held.length > 1) {
      this.#heldBytes -= this.#held.shift()?.byteLength ?? 0;
    }
  }

  /** The PTY session ended: bash `exit` returns to light. */
  ptyEnded(): void {
    this.setSessionOpen(false);
    this.#drop();
    // A session that ends while light owns the screen reopens on the next
    // full command; reconnecting here could loop against a closing host.
    if (this.#mode !== "full") return;
    this.#mode = "light";
    this.#apply(this.#discipline.returnFromFull());
    // Reconnect quietly so the next full command is warm. No banner, no reset.
    this.#ports.connect().catch((cause: unknown) => {
      reportCatchFailure("light-shell.reconnect", cause);
    });
  }

  reopen(): void {
    this.#apply(this.#discipline.reopen());
  }

  dispose(): void {
    this.#disposed = true;
    this.#abort?.abort();
    clearTimeout(this.#busyTimer);
  }

  #drop(): void {
    this.#held = [];
    this.#heldBytes = 0;
  }

  #apply(step: Step): void {
    if (this.#disposed) return;
    if (step.effect.kind === "clear") this.#ports.forget();
    for (const chunk of step.chunks) {
      if (chunk.record) this.#ports.commit(this.#encoder.encode(chunk.text));
      else this.#ports.live(chunk.text);
    }
    if (step.log.length > 0) this.#ports.log(step.log);
    switch (step.effect.kind) {
      case "run":
        this.#run(step.effect.request);
        break;
      case "escalate":
        this.#escalate(step.effect.request.command);
        break;
      case "interrupt":
        this.#abort?.abort();
        this.#setBusy(false);
        break;
      default:
        break;
    }
    this.#publish();
  }

  #run(request: LightRunInput): void {
    const controller = new AbortController();
    this.#abort = controller;
    this.#busyTimer = setTimeout(() => {
      this.#setBusy(true);
    }, BUSY_DELAY_MS);
    this.#ports
      .runLight(request, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        this.#apply(this.#discipline.finish(result));
      })
      .catch((cause: unknown) => {
        reportCatchFailure("light-shell.command", cause);
        if (!controller.signal.aborted)
          this.#apply(this.#discipline.fail("light"));
      })
      .finally(() => {
        if (this.#abort === controller) {
          this.#abort = null;
          this.#setBusy(false);
        }
      });
  }

  #escalate(command: string): void {
    this.#mode = "full";
    const send = () => this.#ports.send(`${command}\n`);
    const failed = (cause: unknown) => {
      reportCatchFailure("light-shell.full", cause);
      if (this.#mode !== "full") return;
      this.#mode = "light";
      this.#drop();
      this.#apply(this.#discipline.fail("full"));
    };
    if (this.#sessionOpen) {
      // The shell's own prompt replaces the light prompt in place.
      for (const bytes of this.#held) this.#ports.commit(bytes);
      this.#drop();
      send().catch(failed);
      return;
    }
    this.#drop();
    this.#ports.connect().then(send).catch(failed);
  }

  #setBusy(busy: boolean): void {
    clearTimeout(this.#busyTimer);
    if (this.#busy === busy) return;
    this.#busy = busy;
    this.#publish();
  }

  #publish(): void {
    if (this.#disposed) return;
    const route = this.#discipline.route;
    this.#ports.view({
      phase: this.#discipline.phase,
      route: route.where,
      routeLabel:
        route.where === "invalid"
          ? `invalid: ${route.message}`
          : route.where === "full"
            ? "full shell"
            : "light shell",
      busy: this.#busy && this.#discipline.phase === "busy",
    });
  }
}
