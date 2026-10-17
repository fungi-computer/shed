import type { AppRoot } from "@fungi.computer/agar";
import {
  openComputerTerminal,
  type ComputerTerminalInformation,
} from "@fungi.computer/agar/computer";
import { Button } from "@fungi.computer/caps/components/button";
import { Loader } from "@fungi.computer/caps/components/loader";
import { Display } from "@fungi.computer/caps/components/surface";
import { terminalPalette } from "@fungi.computer/stipe";
import { getTheme, subscribeTheme } from "@fungi.computer/stipe/theme";
import { FitAddon, Terminal } from "ghostty-web";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { loadGhostty, loadTerminalFont } from "./ghostty-runtime.js";
import type { LightRunInput, LightRunResult } from "./light-shell/connector.js";
import { LightController, type LightView } from "./light-shell/controller.js";
import type { KeyInput } from "./light-shell/discipline.js";
import { renderConnecting, renderWelcome } from "./terminal-welcome.js";

export type TerminalState = "starting" | "open" | "failed" | "closed";
type TerminalSession = Awaited<ReturnType<typeof openComputerTerminal>>;
type TerminalSize = Readonly<{ cols: number; rows: number }>;
const MAX_THEME_REPLAY_BYTES = 4 * 1024 * 1024;
const TERMINAL_FONT_SIZE = 13;

export type TerminalStatus = Readonly<{
  name: string | null;
  state: TerminalState;
  information: ComputerTerminalInformation | null;
}>;

/** Present when the light shell fronts this terminal; absent means full only. */
export type LightShellPort = Readonly<{
  runLight: (
    input: LightRunInput,
    signal: AbortSignal,
  ) => Promise<LightRunResult>;
}>;

const IDLE_VIEW: LightView = {
  phase: "idle",
  route: "light",
  routeLabel: "light shell",
  busy: false,
};
const MAX_LOG_ROWS = 500;
/** What the terminal surface hands the light controller: keys, text, layout. */
type LightInput = Readonly<{
  key: (event: KeyInput) => boolean;
  input: (data: string) => boolean;
  repaint: (columns: number) => void;
  setColumns: (columns: number) => void;
  reopen: () => void;
}>;

export function TerminalPanel({
  app,
  computerId,
  screen,
  light,
  onStatusChange,
}: {
  app: Pick<AppRoot, "capabilities">;
  computerId: string;
  screen?: ReactNode;
  light?: LightShellPort;
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
  const lightRef = useRef(light);
  lightRef.current = light;
  const lightInputRef = useRef<LightInput | null>(null);
  const [view, setView] = useState<LightView>(IDLE_VIEW);
  // Rows keep their ids as the log is capped, so assistive technology hears
  // only appended rows, never a re-render of every row.
  const [logRows, setLogRows] = useState<
    readonly Readonly<{ id: number; text: string }>[]
  >([]);
  const nextLogId = useRef(0);
  const hasLight = light !== undefined;

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
        // Ghostty 0.4.0 fills a written grid with stale WASM cells when its
        // columns grow and reflows them when they shrink. Rebuild a terminal
        // that holds output at the new width from its bounded history instead.
        // A rows-only change (a soft keyboard opening) resizes in place:
        // rebuilding replaces the input element and closes the keyboard.
        if (
          terminal.cols !== dimensions.cols &&
          outputHistoryBytes.current > 0 &&
          rebuild
        ) {
          rebuild(dimensions);
          return;
        }
        terminal.resize(dimensions.cols, dimensions.rows);
        lightInputRef.current?.setColumns(terminal.cols);
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
    // Soft keyboards (Android Gboard) send Backspace and some insertions as
    // keyCode 229 without a composition, which Ghostty ignores. They arrive
    // here instead; a desktop key Ghostty handled never reaches this.
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      const light = lightInputRef.current;
      const send = (text: string) => {
        void writerRef.current
          ?.write(new TextEncoder().encode(text))
          .catch((cause: unknown) => {
            console.error("Shed terminal operation failed", cause);
          });
      };
      const key = (name: string) =>
        light?.key({
          key: name,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          isComposing: false,
        }) ?? false;
      switch (event.inputType) {
        case "deleteContentBackward":
          event.preventDefault();
          if (!key("Backspace")) send("\x7f");
          break;
        case "insertLineBreak":
        case "insertParagraph":
          event.preventDefault();
          if (!key("Enter")) send("\r");
          break;
        case "insertText":
          if (!event.data) return;
          event.preventDefault();
          if (!light?.input(event.data)) send(event.data);
          break;
        default:
          break;
      }
    };
    host.addEventListener("beforeinput", onBeforeInput);
    const themeRoot =
      host.closest<HTMLElement>("[data-theme]") ?? document.documentElement;
    // A theme can change the mono font, so read it for each new renderer.
    const terminalFont = () =>
      getComputedStyle(host).getPropertyValue("--font-mono") ||
      "Maple Mono, ui-monospace, monospace";
    void Promise.all([
      loadGhostty(),
      loadTerminalFont(TERMINAL_FONT_SIZE, terminalFont()),
    ])
      .then(([ghostty]) => {
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
            fontSize: TERMINAL_FONT_SIZE,
            fontFamily: terminalFont(),
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
            // In light mode the line discipline owns typed, pasted and IME text.
            if (lightInputRef.current?.input(data)) return;
            void writerRef.current
              ?.write(encoder.encode(data))
              .catch((cause: unknown) => {
                console.error("Shed terminal operation failed", cause);
              });
          });
          terminal.attachCustomKeyEventHandler(
            (event) => lightInputRef.current?.key(event) ?? false,
          );
          // Ghostty may reuse WASM storage; clear it before replaying history.
          terminal.write("\x1b[2J\x1b[3J\x1b[H");
          for (const chunk of outputHistory.current) terminal.write(chunk);
          // The live prompt is never in the replay; draw it again.
          lightInputRef.current?.repaint(terminal.cols);
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
          void loadTerminalFont(TERMINAL_FONT_SIZE, terminalFont())
            .then(() => {
              if (!alive || name !== activeTheme) return;
              const current = terminalRef.current;
              createTerminal(
                name,
                current
                  ? { cols: current.cols, rows: current.rows }
                  : undefined,
              );
            })
            .catch((cause: unknown) => {
              console.error("Shed terminal operation failed", cause);
              if (alive) setState("failed");
            });
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
      host.removeEventListener("beforeinput", onBeforeInput);
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
    let connecting: Promise<void> | null = null;
    let lightController: LightController | null = null;
    let lightInput: LightInput | null = null;
    const controller = new AbortController();
    const encoder = new TextEncoder();
    setState("starting");
    setComputerName(null);
    setInformation(null);
    setView(IDLE_VIEW);
    setLogRows([]);

    const openSession = async (): Promise<TerminalSession | null> => {
      const terminal = terminalRef.current;
      if (!terminal) return null;
      const opened = await openComputerTerminal(
        app.capabilities,
        {
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        },
        { signal: controller.signal },
      );
      if (!alive) {
        await opened.close();
        return null;
      }
      return opened;
    };
    const attach = (opened: TerminalSession) => {
      session = opened;
      sessionRef.current = opened;
      reader = opened.output.getReader();
      writer = opened.input.getWriter();
      writerRef.current = writer;
      lightController?.setSessionOpen(true);
      return reader;
    };
    const detach = () => {
      if (writerRef.current === writer) writerRef.current = null;
      writer?.releaseLock();
      if (sessionRef.current === session) sessionRef.current = null;
      void session?.close().catch((cause: unknown) => {
        console.error("Shed terminal operation failed", cause);
        return undefined;
      });
    };
    // With the light shell in front, PTY bytes go to its controller, which
    // holds them until a full command takes over. Without it they go straight
    // to the screen.
    const pump = async (
      opened: TerminalSession,
      activeReader: ReadableStreamDefaultReader<Uint8Array>,
    ) => {
      try {
        for (;;) {
          const next = await activeReader.read();
          if (controller.signal.aborted || next.done) break;
          const chunk = next.value.slice();
          if (lightController) lightController.output(chunk);
          else writeOutput(chunk);
        }
      } catch (cause) {
        console.error("Shed terminal operation failed", cause);
        if (!lightController) {
          if (!controller.signal.aborted) setState("failed");
          return;
        }
      }
      if (controller.signal.aborted || sessionRef.current !== opened) return;
      detach();
      if (lightController) lightController.ptyEnded();
      else setState("closed");
    };
    // A full command, or the shell ending, needs a session again. No banner,
    // no reset: the light scrollback stays where it is.
    const connect = () => {
      if (sessionRef.current) return Promise.resolve();
      connecting ??= (async () => {
        const opened = await openSession();
        if (!opened) return;
        void pump(opened, attach(opened));
      })().finally(() => {
        connecting = null;
      });
      return connecting;
    };

    const start = async () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      outputHistory.current = [];
      outputHistoryBytes.current = 0;
      terminal.reset();
      terminal.write("\x1b[2J\x1b[3J\x1b[H");
      writeOutput(encoder.encode(renderConnecting(computerId)));
      try {
        const opened = await openSession();
        if (!opened) return;
        // Replace the transient connecting row before any buffered PTY bytes.
        // The history includes the welcome, so theme swaps replay it once.
        outputHistory.current = [];
        outputHistoryBytes.current = 0;
        terminalRef.current?.reset();
        terminalRef.current?.write("\x1b[2J\x1b[3J\x1b[H");
        const cols = Math.max(2, terminalRef.current?.cols ?? terminal.cols);
        writeOutput(
          encoder.encode(
            renderWelcome({
              cols,
              information: opened.information,
              light: lightRef.current !== undefined,
            }),
          ),
        );
        if (lightRef.current) {
          const created = new LightController(
            {
              live: (text) => terminalRef.current?.write(text),
              commit: writeOutput,
              forget: () => {
                outputHistory.current = [];
                outputHistoryBytes.current = 0;
              },
              send: (text) => {
                const active = writerRef.current;
                return active
                  ? active.write(encoder.encode(text))
                  : Promise.reject(new Error("The full shell is not open"));
              },
              connect,
              runLight: (input, signal) => {
                const port = lightRef.current;
                return port
                  ? port.runLight(input, signal)
                  : Promise.reject(new Error("The light shell is unavailable"));
              },
              view: setView,
              log: (text) => {
                const added = text.split("\n").map((row) => ({
                  id: (nextLogId.current += 1),
                  text: row,
                }));
                setLogRows((rows) => [...rows, ...added].slice(-MAX_LOG_ROWS));
              },
            },
            { computerName: opened.information.computerName, columns: cols },
          );
          lightController = created;
          lightInput = {
            key: (event) => created.key(event),
            input: (data) => created.input(data),
            repaint: (columns) => {
              created.repaint(columns);
            },
            setColumns: (columns) => {
              created.setColumns(columns);
            },
            reopen: () => {
              created.reopen();
            },
          };
          lightInputRef.current = lightInput;
          created.start();
        }
        setComputerName(opened.information.computerName);
        setInformation(opened.information);
        const activeReader = attach(opened);
        setState("open");
        await pump(opened, activeReader);
      } catch (cause) {
        console.error("Shed terminal operation failed", cause);

        if (!controller.signal.aborted) setState("failed");
      }
    };
    void start();

    return () => {
      alive = false;
      controller.abort();
      lightController?.dispose();
      if (lightInputRef.current === lightInput) lightInputRef.current = null;
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

  const lightPhase = view.phase === "idle" ? "light" : view.phase;
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-shell-state={hasLight ? lightPhase : undefined}
      data-route={hasLight ? view.route : undefined}
    >
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
          {hasLight && !screen && view.busy ? (
            <div className="pointer-events-none absolute right-3 bottom-2">
              <Loader
                data-shell-busy="true"
                size="sm"
                tone="primary"
                label="Running command"
              />
            </div>
          ) : null}
          {hasLight && !screen && view.phase === "closed" ? (
            <div className="absolute bottom-2 left-2">
              <Button
                size="sm"
                variant="accent"
                onClick={() => {
                  lightInputRef.current?.reopen();
                  terminalRef.current?.focus();
                }}
              >
                Reopen shell
              </Button>
            </div>
          ) : null}
        </div>
      </Display>
      {hasLight ? (
        <>
          {/* The canvas has no text. These carry the committed rows and the
              route to assistive technology. */}
          <div role="log" aria-label="Shell output" className="sr-only">
            {logRows.map((row) => (
              <div key={row.id}>{row.text}</div>
            ))}
          </div>
          <div role="status" aria-live="polite" className="sr-only">
            {view.routeLabel}
          </div>
        </>
      ) : null}
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
