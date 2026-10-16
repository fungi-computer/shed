import type { AppRoot } from "@fungi.computer/agar";
import {
  openComputerTerminal,
  type ComputerTerminalInformation,
} from "@fungi.computer/agar/computer";
import { Button } from "@fungi.computer/caps/components/button";
import { Display } from "@fungi.computer/caps/components/surface";
import { terminalPalette } from "@fungi.computer/stipe";
import { getTheme, subscribeTheme } from "@fungi.computer/stipe/theme";
import { FitAddon, Ghostty, Terminal } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { renderConnecting, renderWelcome } from "./terminal-welcome.js";

export type TerminalState = "starting" | "open" | "failed" | "closed";
type TerminalSession = Awaited<ReturnType<typeof openComputerTerminal>>;
type TerminalSize = Readonly<{ cols: number; rows: number }>;
const MAX_THEME_REPLAY_BYTES = 4 * 1024 * 1024;

export type TerminalStatus = Readonly<{
  name: string | null;
  state: TerminalState;
  information: ComputerTerminalInformation | null;
}>;

export function TerminalPanel({
  app,
  computerId,
  screen,
  run,
  onStatusChange,
}: {
  app: Pick<AppRoot, "capabilities">;
  computerId: string;
  screen?: ReactNode;
  /** Sent as one typed line once the session is open; each distinct value is sent once. */
  run?: string | null;
  onStatusChange?: (status: TerminalStatus) => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const outputHistory = useRef<Uint8Array[]>([]);
  const outputHistoryBytes = useRef(0);
  const writerRef = useRef<WritableStreamDefaultWriter<Uint8Array> | null>(
    null,
  );
  const sessionRef = useRef<TerminalSession | null>(null);
  const [terminalReady, setTerminalReady] = useState(false);
  const [state, setState] = useState<TerminalState>("starting");
  const [retry, setRetry] = useState(0);
  const [computerName, setComputerName] = useState<string | null>(null);
  const [information, setInformation] =
    useState<ComputerTerminalInformation | null>(null);
  useEffect(() => {
    onStatusChange?.({ name: computerName, state, information });
  }, [computerName, state, information, onStatusChange]);
  const sentRunRef = useRef<string | null>(null);
  useEffect(() => {
    if (state !== "open") {
      sentRunRef.current = null;
      return;
    }
    if (!run || sentRunRef.current === run) return;
    sentRunRef.current = run;
    const encoder = new TextEncoder();
    void writerRef.current
      ?.write(encoder.encode(`${run}\n`))
      .catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);
      });
  }, [run, state]);

  const writeOutput = useCallback((bytes: Uint8Array) => {
    outputHistory.current.push(bytes);
    outputHistoryBytes.current += bytes.byteLength;
    while (
      outputHistoryBytes.current > MAX_THEME_REPLAY_BYTES &&
      outputHistory.current.length > 1
    ) {
      const oldest = outputHistory.current.shift();
      outputHistoryBytes.current -= oldest?.byteLength ?? 0;
    }
    terminalRef.current?.write(bytes);
  }, []);

  // The PTY outlives a Ghostty renderer swap on theme changes. Replay the
  // bounded output tail into the new palette without reconnecting the session.
  useEffect(() => {
    let alive = true;
    let focusFrame = 0;
    let resizeObserver: ResizeObserver | undefined;
    let unsubscribeTheme: (() => void) | undefined;
    let rebuild: ((size: TerminalSize) => void) | undefined;

    const resize = () => {
      const terminal = terminalRef.current;
      const fit = fitRef.current;
      const pane = paneRef.current;
      const terminalHost = hostRef.current;
      if (
        !alive ||
        !terminal ||
        !fit ||
        !pane ||
        !terminalHost ||
        pane.clientWidth === 0 ||
        pane.clientHeight === 0
      )
        return;
      // A nonzero pane may still consist entirely of borders and padding.
      const style = getComputedStyle(terminalHost);
      const horizontalPadding =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const verticalPadding =
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      if (
        terminalHost.clientWidth <= horizontalPadding ||
        terminalHost.clientHeight <= verticalPadding
      )
        return;
      // FitAddon's fit() drops changes during its 50ms resize guard. Use its
      // public measurements so the observer always applies the latest layout.
      const dimensions = fit.proposeDimensions();
      if (!dimensions) return;
      if (
        terminal.cols !== dimensions.cols ||
        terminal.rows !== dimensions.rows
      ) {
        // Ghostty 0.4.0 fills a written grid with stale WASM cells when it
        // grows and reflows them when it shrinks. Rebuild a terminal that holds
        // output at the new size from its bounded history instead.
        if (outputHistoryBytes.current > 0 && rebuild) {
          rebuild(dimensions);
          return;
        }
        terminal.resize(dimensions.cols, dimensions.rows);
      }
      setTerminalReady(true);
      const session = sessionRef.current;
      if (!session) return;
      void session
        .resize({
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        })
        .catch((cause: unknown) => {
          console.error("Shed terminal operation failed", cause);
        });
    };
    const hide = () => terminalRef.current?.blur();
    const show = () => {
      cancelAnimationFrame(focusFrame);
      focusFrame = requestAnimationFrame(() => {
        if (!alive || document.visibilityState !== "visible") return;
        resize();
        terminalRef.current?.focus();
      });
    };
    const syncVisibility = () => {
      if (document.visibilityState === "hidden") hide();
      else show();
    };

    const host = hostRef.current;
    const pane = paneRef.current;
    if (!host || !pane) return;
    const themeRoot =
      host.closest<HTMLElement>("[data-theme]") ?? document.documentElement;
    void Ghostty.load(wasmUrl)
      .then((ghostty) => {
        if (!alive) return;
        let activeTheme = getTheme(themeRoot) ?? "mocha";
        const createTerminal = (themeName: string, size?: TerminalSize) => {
          terminalRef.current?.dispose();
          host.replaceChildren();
          const theme = terminalPalette(themeName);
          const terminal = new Terminal({
            ghostty,
            cursorBlink: true,
            cursorStyle: "block",
            fontSize: 13,
            fontFamily:
              getComputedStyle(document.documentElement).getPropertyValue(
                "--font-mono",
              ) || "Maple Mono, ui-monospace, monospace",
            theme,
            ...size,
          });
          terminalRef.current = terminal;
          terminal.open(host);
          const fit = new FitAddon();
          terminal.loadAddon(fit);
          fitRef.current = fit;
          const encoder = new TextEncoder();
          terminal.onData((data) => {
            void writerRef.current
              ?.write(encoder.encode(data))
              .catch((cause: unknown) => {
                console.error("Shed terminal operation failed", cause);
              });
          });
          // Ghostty may reuse WASM storage; clear it before replaying history.
          terminal.write("\x1b[2J\x1b[3J\x1b[H");
          for (const chunk of outputHistory.current) terminal.write(chunk);
          // The host's padding can have dimensions while its pane is still
          // collapsed. Wait for the pane before fitting or opening the PTY.
          // Fitting last means a rebuild never touches this replaced terminal.
          void document.fonts.ready.then(resize);
          resize();
        };
        rebuild = (size) => {
          createTerminal(activeTheme, size);
        };
        createTerminal(activeTheme);
        unsubscribeTheme = subscribeTheme((name) => {
          if (name === activeTheme || !terminalPalette(name)) return;
          activeTheme = name;
          const current = terminalRef.current;
          createTerminal(
            name,
            current ? { cols: current.cols, rows: current.rows } : undefined,
          );
        }, themeRoot);
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(pane);
        document.addEventListener("visibilitychange", syncVisibility);
        window.addEventListener("blur", hide);
        window.addEventListener("focus", show);
      })
      .catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);

        if (alive) setState("failed");
      });

    return () => {
      alive = false;
      cancelAnimationFrame(focusFrame);
      resizeObserver?.disconnect();
      unsubscribeTheme?.();
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("blur", hide);
      window.removeEventListener("focus", show);
      void sessionRef.current?.close().catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);
        return undefined;
      });
      try {
        terminalRef.current?.dispose();
      } catch (cause) {
        console.error("Shed terminal operation failed", cause);

        // Terminal disposal is best effort during iframe teardown.
      }
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Agar owns the authenticated bridge and reconnect lifecycle. Shed owns one
  // terminal session handle and closes it when this Computer/window changes.
  useEffect(() => {
    if (!terminalReady) return;
    let alive = true;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let session: TerminalSession | undefined;
    const controller = new AbortController();
    setState("starting");
    setComputerName(null);
    setInformation(null);

    const start = async () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      outputHistory.current = [];
      outputHistoryBytes.current = 0;
      terminal.reset();
      terminal.write("\x1b[2J\x1b[3J\x1b[H");
      const encoder = new TextEncoder();
      writeOutput(encoder.encode(renderConnecting(computerId)));
      try {
        session = await openComputerTerminal(
          app.capabilities,
          {
            cols: Math.max(2, terminal.cols),
            rows: Math.max(2, terminal.rows),
          },
          { signal: controller.signal },
        );
        if (!alive) {
          await session.close();
          return;
        }
        // Replace the transient connecting row before any buffered PTY bytes.
        // The history includes the welcome, so theme swaps replay it once.
        outputHistory.current = [];
        outputHistoryBytes.current = 0;
        terminalRef.current?.reset();
        terminalRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
        writeOutput(
          encoder.encode(
            renderWelcome({
              cols: Math.max(2, terminalRef.current?.cols ?? terminal.cols),
              information: session.information,
            }),
          ),
        );
        setComputerName(session.information.computerName);
        setInformation(session.information);
        sessionRef.current = session;
        reader = session.output.getReader();
        writer = session.input.getWriter();
        writerRef.current = writer;
        setState("open");

        for (;;) {
          const next = await reader.read();
          if (controller.signal.aborted || next.done) break;
          const chunk = next.value.slice();
          writeOutput(chunk);
        }
        if (!controller.signal.aborted) setState("closed");
      } catch (cause) {
        console.error("Shed terminal operation failed", cause);

        if (!controller.signal.aborted) setState("failed");
      }
    };
    void start();

    return () => {
      alive = false;
      controller.abort();
      void reader?.cancel().catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);
        return undefined;
      });
      if (writerRef.current === writer) writerRef.current = null;
      writer?.releaseLock();
      if (sessionRef.current === session) sessionRef.current = null;
      void session?.close().catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);
        return undefined;
      });
    };
  }, [app, computerId, retry, terminalReady, writeOutput]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (screen) terminalRef.current?.blur();
      else {
        terminalRef.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [Boolean(screen)]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <Display size="sm" placement="embedded" fit="fill" density="compact">
        <div ref={paneRef} className="relative min-h-0 flex-1 overflow-hidden">
          <div
            ref={hostRef}
            className={`terminal-host absolute inset-0 overflow-hidden px-2 pt-1 pb-0.5${screen ? " opacity-0" : ""}`}
            aria-hidden={screen ? true : undefined}
          />
          {screen ? (
            <div className="absolute inset-0 flex flex-col">{screen}</div>
          ) : null}
        </div>
      </Display>
      {!screen && (state === "failed" || state === "closed") && (
        <div className="absolute inset-0 grid content-center justify-items-center gap-2 bg-base-200 p-4 text-center">
          <p className="m-0 text-sm">
            {state === "failed"
              ? terminalReady
                ? "Terminal could not connect."
                : "Terminal display could not start. Reload Shed to retry."
              : "Terminal session ended."}
          </p>
          {terminalReady && (
            <Button
              className="terminal-reopen"
              size="sm"
              variant="accent"
              onClick={() => {
                setRetry((value) => value + 1);
              }}
            >
              Reopen terminal
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
