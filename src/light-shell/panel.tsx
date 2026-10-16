import type { ComputerTerminalInformation } from "@fungi.computer/agar/computer";
import { Loader } from "@fungi.computer/caps/components/loader";
import { Button } from "@fungi.computer/caps/components/button";
import { fungiWordmark } from "@fungi.computer/lantern/banner";
import {
  prepareShellPrompt,
  completeShellCommand,
  type ShellRoute,
} from "@fungi.computer/computer/light-shell";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { editLine, editLineKey, type LineState } from "./line-editor.js";
import { appendTranscript } from "./transcript.js";
import { reportCatchFailure } from "../failure.js";
import { CommandHistory } from "./history.js";
import { maximumCommandCharacters } from "@fungi.computer/computer/operations";

export type LightRunInput = Readonly<{
  command: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;
export type LightRunResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

/** The view has no host authority. Its owner supplies admitted execution ports. */
export type LightShellPanelProps = Readonly<{
  information: ComputerTerminalInformation;
  runLight: (
    input: LightRunInput,
    signal: AbortSignal,
  ) => Promise<LightRunResult>;
  openFull: (input: LightRunInput, signal: AbortSignal) => Promise<void>;
}>;

export function LightShellPanel({
  information,
  runLight,
  openFull,
}: LightShellPanelProps) {
  const input = useRef<HTMLInputElement>(null);
  const display = useRef<HTMLDivElement>(null);
  const history = useRef(new CommandHistory());
  const controller = useRef(new AbortController());
  const accepted = useRef(false);
  const completionPrefix = useRef<string | null>(null);
  const [line, setLine] = useState<LineState>({ text: "", cursor: 0 });
  const [cwd, setCwd] = useState("/workspace");
  const [env, setEnv] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState<
    "light" | "busy" | "starting" | "full" | "closed"
  >("light");
  const [rows, setRows] = useState<readonly string[]>([]);
  const [exitCode, setExitCode] = useState(0);
  const [columns, setColumns] = useState(80);
  const [waiting, setWaiting] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const prompt = prepareShellPrompt(line.text);
  const route: ShellRoute =
    prompt.kind === "command"
      ? prompt.route
      : prompt.kind === "invalid"
        ? { where: "invalid", message: prompt.message }
        : { where: "light" };
  const suggestion =
    line.cursor === line.text.length
      ? history.current.suggest(line.text)
      : null;
  const facts = [information.computerName];
  if (information.teamName !== "unconfigured")
    facts.push(`Team ${information.teamName}`);
  if (information.modelDoor !== "unconfigured")
    facts.push(`model door: ${information.modelDoor}`);
  const append = useCallback((text: string) => {
    setRows((previous) => appendTranscript(previous, text));
  }, []);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    return () => {
      active.abort();
    };
  }, []);
  useEffect(() => {
    const element = display.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setColumns(Math.max(2, Math.floor(entry.contentRect.width / 8)));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  useLayoutEffect(() => {
    input.current?.setSelectionRange(line.cursor, line.cursor);
  }, [line]);
  useEffect(() => {
    if (status === "light") input.current?.focus();
  }, [status]);
  useEffect(() => {
    if (status !== "busy") {
      setWaiting(false);
      return;
    }
    const timer = setTimeout(() => {
      setWaiting(true);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);
  const recall = (text: string | null) => {
    if (text !== null) setLine({ text, cursor: text.length });
  };
  const submit = async () => {
    if (accepted.current || line.text.trim().length === 0) return;
    if (prompt.kind === "light" || prompt.kind === "exit") {
      setLine({ text: "", cursor: 0 });
      if (prompt.kind === "light") append("Already in the light shell.");
      else {
        history.current = new CommandHistory();
        setSearch(null);
        setStatus("closed");
      }
      return;
    }
    if (route.where === "invalid") {
      append(route.message);
      return;
    }
    accepted.current = true;
    const command = prompt.kind === "command" ? prompt.command : line.text;
    const request = { command, cwd, env };
    history.current.record(line.text);
    append(
      `${exitCode === 0 ? "✓" : `✗ ${String(exitCode)}`} fungi@${information.computerName} ${cwd} ◦light ➜ ${line.text}`,
    );
    setLine({ text: "", cursor: 0 });
    setSearch(null);
    try {
      if (route.where === "full") {
        setStatus("starting");
        append(`Starting the full shell for ${command}…`);
        await openFull(request, controller.current.signal);
        if (!controller.current.signal.aborted) setStatus("full");
      } else {
        setStatus("busy");
        const result = await runLight(request, controller.current.signal);
        if (controller.current.signal.aborted) return;
        append(result.stdout + result.stderr);
        setCwd(result.cwd);
        setEnv(result.env);
        setExitCode(result.exitCode);
        if (result.exitCode === 127)
          append(
            "light: command not found; use full to run it in the full shell.",
          );
        setStatus("light");
      }
    } catch (cause) {
      reportCatchFailure("light-shell.command", cause);
      if (!controller.current.signal.aborted) {
        append(
          route.where === "full"
            ? "The full shell could not start. Light commands still work."
            : "The light shell could not run this command.",
        );
        setStatus("light");
      }
    } finally {
      accepted.current = false;
    }
  };
  return (
    <div
      ref={display}
      className="flex h-full min-h-0 flex-1 flex-col overflow-auto px-2 pt-1 pb-0.5 font-mono text-[13px] leading-tight"
      data-shell-state={status}
    >
      <pre className="m-0 leading-none text-primary" aria-hidden="true">
        {columns >= 60 ? fungiWordmark : ""}
      </pre>
      <p className="m-0">{facts.join(" · ")}</p>
      <p className="m-0 text-base-content/60">
        light shell · instant · try: ls · rg TODO · jq . package.json
      </p>
      <p className="m-0" aria-hidden="true">
        &nbsp;
      </p>
      <div
        role="log"
        aria-label="Shell output"
        className="whitespace-pre-wrap break-words"
      >
        {rows.map((row, index) => (
          <div key={index}>{row}</div>
        ))}
      </div>
      {status === "closed" ? (
        <Button
          size="sm"
          variant="accent"
          onClick={() => {
            setStatus("light");
          }}
        >
          Reopen shell
        </Button>
      ) : null}
      {waiting && status === "busy" ? (
        <Loader
          data-shell-busy="true"
          size="sm"
          tone="primary"
          label="Running command"
        />
      ) : null}
      {status !== "starting" && status !== "full" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className={`mt-1 ${exitCode === 0 ? "text-base-content" : "text-error"}`}
        >
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              aria-label="Last command status"
              className={exitCode === 0 ? "text-base-content" : "text-error"}
            >
              {exitCode === 0 ? "✓" : `✗ ${String(exitCode)}`}
            </span>
            <span>
              fungi@{information.computerName} {cwd}
            </span>
            <span className="text-info">◦light</span>
            <span>➜</span>
            <div className="relative min-w-0 flex-1 basis-48">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 whitespace-pre text-base-content/40"
              >
                <span className="invisible">{line.text}</span>
                {suggestion}
              </span>
              <input
                ref={input}
                aria-label="Shell command"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={status !== "light"}
                value={line.text}
                maxLength={maximumCommandCharacters}
                data-route={route.where}
                aria-invalid={route.where === "invalid"}
                className={`relative w-full border-0 bg-transparent p-0 font-mono outline-none ${route.where === "invalid" ? "text-error underline decoration-wavy" : route.where === "full" ? "text-warning" : "text-success"}`}
                onChange={(event) => {
                  completionPrefix.current = null;
                  setLine({
                    text: event.target.value,
                    cursor:
                      event.target.selectionStart ?? event.target.value.length,
                  });
                }}
                onPointerUp={(event) => {
                  const start = event.currentTarget.selectionStart;
                  if (
                    start === null ||
                    start !== event.currentTarget.selectionEnd
                  )
                    return;
                  setLine((previous) =>
                    previous.cursor === start
                      ? previous
                      : { ...previous, cursor: start },
                  );
                }}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    event.shiftKey ||
                    event.altKey ||
                    event.metaKey
                  )
                    return;
                  const currentLine = {
                    text: event.currentTarget.value,
                    cursor:
                      event.currentTarget.selectionStart ??
                      event.currentTarget.value.length,
                  };
                  if (
                    event.key === "Tab" &&
                    currentLine.cursor === currentLine.text.length
                  ) {
                    const completions = completeShellCommand(currentLine.text);
                    if (completions === null) return;
                    event.preventDefault();
                    if ("kind" in completions) {
                      append(completions.message);
                      return;
                    }
                    if (completions.length === 1) {
                      const text = `${completions[0].name} `;
                      setLine({ text, cursor: text.length });
                      completionPrefix.current = null;
                    } else if (completionPrefix.current === currentLine.text) {
                      append(
                        completions
                          .map(
                            (item) =>
                              `${item.name}${item.where === "full" ? " ⚡" : ""}`,
                          )
                          .join(" · "),
                      );
                      completionPrefix.current = null;
                    } else completionPrefix.current = currentLine.text;
                    return;
                  }
                  if (event.ctrlKey && event.key.toLowerCase() === "r") {
                    event.preventDefault();
                    setSearch(search ?? "");
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    recall(history.current.previous(line.text));
                    return;
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    recall(history.current.next());
                    return;
                  }
                  if (
                    event.key === "ArrowRight" &&
                    suggestion &&
                    currentLine.cursor === currentLine.text.length &&
                    event.currentTarget.selectionStart ===
                      event.currentTarget.selectionEnd
                  ) {
                    event.preventDefault();
                    setLine(
                      editLine(currentLine, {
                        type: "insert",
                        text: suggestion,
                      }),
                    );
                    return;
                  }
                  if (
                    (event.currentTarget.selectionStart ?? 0) !==
                    (event.currentTarget.selectionEnd ?? 0)
                  )
                    return;
                  const edited = editLineKey(currentLine, event.nativeEvent);
                  if (edited) {
                    event.preventDefault();
                    setLine(edited);
                  }
                }}
              />
            </div>
          </div>
          {search !== null ? (
            <label className="mt-2 flex gap-2 text-base-content/60">
              reverse search
              <input
                aria-label="Search command history"
                value={search}
                autoFocus
                className="min-w-0 flex-1 bg-transparent outline-none"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" ||
                    (event.ctrlKey && event.key.toLowerCase() === "r")
                  ) {
                    event.preventDefault();
                    recall(history.current.search(search, line.text));
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setSearch(null);
                    input.current?.focus();
                  }
                }}
              />
            </label>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
