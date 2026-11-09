import {
  computerPortExposureSchema,
  type ComputerPorts,
} from "@fungi.computer/agar/computer";
import {
  StatusTrayNote,
  StatusTrayRow,
} from "@fungi.computer/caps/blocks/status-tray";
import {
  FormFields,
  SchemaForm,
  field,
  useSchemaForm,
} from "@fungi.computer/caps/form";
import { Schema } from "effect";
import { HoldButton } from "@fungi.computer/caps/components/hold-button";
import { Screen } from "@fungi.computer/caps/components/surface";
import { InlineCode } from "@fungi.computer/caps/components/inline-code";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { Alert } from "@fungi.computer/caps/components/alert";
import { Loader } from "@fungi.computer/caps/components/loader";
import { Button } from "@fungi.computer/caps/components/button";
import {
  Status,
  type StatusTone,
} from "@fungi.computer/caps/components/status";
import { Input } from "@fungi.computer/caps/components/input";
import { ArrowUpRight } from "lucide-react";
import { reorderKeyAttribute } from "@fungi.computer/caps/lib/reorder-motion";
import { useEffect, useRef, useState } from "react";
import { useShedData } from "./shed-data.js";
import { AnimatedInventoryList } from "./inventory-list.js";

const processFields = Schema.Struct({
  command: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(16 * 1024)),
  ).annotate(field({ label: "Command", required: true })),
  port: Schema.NullOr(computerPortExposureSchema.fields.port).annotate(
    field<number | null>({
      label: "Port (optional)",
      min: 1,
      max: 65_535,
      render: (control) => (
        <Input
          name={control.name}
          id={control.id}
          type="number"
          inputMode="numeric"
          min={1}
          max={65_535}
          step={1}
          value={control.value ?? ""}
          disabled={control.disabled}
          aria-describedby={control["aria-describedby"]}
          aria-invalid={control["aria-invalid"]}
          onBlur={() => {
            control.onBlur();
          }}
          onChange={(event) => {
            const input = event.currentTarget;
            control.onChange(input.value === "" ? null : input.valueAsNumber);
          }}
        />
      ),
    }),
  ),
});

/** One-click starters that fill the Start form; they run nothing themselves. */
const processStarters = [
  { command: "pwd", port: null },
  { command: "ls", port: null },
  { command: "echo hello", port: null },
] as const;

export type ShedProcessPanelProps = {
  openPreview: (port: ComputerPorts["ports"][number]) => void;
  processNavigation?: Readonly<{ requestId: string; processId: string }> | null;
};

/** Keep draft and pending form state with the tray owner when its disclosure closes. */
export function useShedProcessPanel({
  openPreview,
  processNavigation,
}: ShedProcessPanelProps) {
  const {
    ports: { items: ports },
    processes: {
      items: processes,
      loading: processLoading,
      error: processError,
      fix: processFix,
      actions: processActions,
      stop: onStopProcess,
      start: onStartProcess,
      output: processOutput,
      unavailableReason: runtimeReason,
    },
  } = useShedData();
  const processList = useRef<HTMLDivElement>(null);
  // A press shorter than the hold teaches the gesture inline, beside the row.
  const pressedAt = useRef(0);
  const [holdHintFor, setHoldHintFor] = useState<string | null>(null);
  const noteRelease = (id: string) => {
    if (Date.now() - pressedAt.current < 900) setHoldHintFor(id);
  };
  const focusedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !processNavigation ||
      focusedRequest.current === processNavigation.requestId ||
      !processList.current
    )
      return;
    const row = [
      ...processList.current.querySelectorAll<HTMLElement>(
        `[${reorderKeyAttribute}]`,
      ),
    ].find(
      (element) =>
        element.getAttribute(reorderKeyAttribute) ===
        processNavigation.processId,
    );
    if (!row) return;
    row.focus();
    focusedRequest.current = processNavigation.requestId;
  }, [processNavigation, processes]);
  const startForm = useSchemaForm({
    schema: processFields,
    defaultValues: { command: "", port: null },
    onSubmit: async ({ command, port }) =>
      (await onStartProcess?.(port === null ? { command } : { command, port }))
        ? { kind: "saved" }
        : {
            kind: "refused",
            fields: {
              command: "Couldn’t confirm the process start. Try again.",
            },
          },
  });
  const processesAvailable =
    processes !== null || processLoading || processError !== null;
  const processContent = (() => {
    if (!processesAvailable)
      return (
        <StatusTrayNote title="Processes can't be listed yet">
          Allow Computer access to see and run commands.
        </StatusTrayNote>
      );
    if (processLoading && processes === null)
      return (
        <StatusTrayNote title="Loading processes">
          Checking this Computer's process inventory.
        </StatusTrayNote>
      );
    if (processError !== null && processes === null)
      return (
        <div className="px-2 pb-3">
          <Alert
            tone={processError.reason === "failed" ? "error" : "warning"}
            role="status"
            title="Can't run commands"
            description={processError.message}
            action={
              processFix === undefined ? undefined : (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void processFix()}
                >
                  {processError.action === "grant"
                    ? "Allow access"
                    : "Try again"}
                </Button>
              )
            }
          />
        </div>
      );
    if (processes === null || processes.length === 0)
      return (
        <div className="px-2 pb-3">
          <EmptyState
            variant="quiet"
            headingLevel={3}
            title="Nothing running"
            description={
              <>
                Try <InlineCode>pwd</InlineCode> to see your working folder.
              </>
            }
            actions={
              <ul
                aria-label="Try one of these"
                className="m-0 flex list-none flex-wrap gap-2 p-0"
              >
                {processStarters.map((starter) => (
                  <li key={starter.command}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        startForm.form.setFieldValue(
                          "command",
                          starter.command,
                        );
                        startForm.form.setFieldValue("port", starter.port);
                        document
                          .querySelector<HTMLElement>(
                            '[aria-label="Start a process"] button[type="submit"]',
                          )
                          ?.focus();
                      }}
                    >
                      <InlineCode>{starter.command}</InlineCode>
                    </Button>
                  </li>
                ))}
              </ul>
            }
          />
        </div>
      );
    return (
      <>
        <div className="px-1">
          <AnimatedInventoryList
            label="Computer process inventory"
            order={processes.map(({ id }) => id)}
            listRoot={processList}
          >
            {processes.map((process) => {
              const action = processActions?.get(process.id);
              const preview =
                process.state === "running"
                  ? ports?.find((item) => item.port === process.port)
                  : undefined;
              let tone: StatusTone;
              let outcome: string;
              if (process.state === "running") {
                tone = "success";
                outcome = "Running";
              } else if (process.state === "uncertain") {
                tone = "warning";
                outcome = "Status unknown";
              } else if (process.exitCode === null) {
                tone = "warning";
                outcome = "Ended · exit not recorded";
              } else {
                tone = process.exitCode === 0 ? "success" : "error";
                outcome = `Exit ${String(process.exitCode)}`;
              }

              // Files a command wrote may still be mid-flight to the Workspace;
              // say so calmly beneath the outcome, never as an error on it.
              const filesNotSyncedYet =
                process.state === "exited" && process.sync === "pending";
              return (
                <StatusTrayRow
                  key={process.id}
                  {...{ [reorderKeyAttribute]: process.id }}
                  role="listitem"
                  data-process-state={process.state}
                  data-process-sync={process.sync}
                  className="py-2"
                  tabIndex={-1}
                  primary={
                    <>
                      <InlineCode
                        className="block truncate"
                        data-process-command
                      >
                        {process.command}
                      </InlineCode>
                      <span className="flex items-center gap-2 text-xs font-normal">
                        <Status
                          size="compact"
                          tone={tone}
                          className={
                            tone === "error" ? "text-error" : undefined
                          }
                          label={action === "stopping" ? "Stopping" : outcome}
                        />
                        {process.port === null ? null : (
                          <span data-process-port>Port {process.port}</span>
                        )}
                      </span>
                      {action === "failed" ? (
                        <span
                          role="status"
                          className="block whitespace-normal text-xs font-normal text-error"
                        >
                          Couldn't stop {process.command}. Try again.
                        </span>
                      ) : (
                        <>
                          {holdHintFor === process.id ? (
                            <span
                              role="status"
                              className="block text-xs font-normal text-(--stipe-fg-muted)"
                            >
                              Hold to stop
                            </span>
                          ) : null}
                          {filesNotSyncedYet ? (
                            <span className="block truncate text-xs font-normal text-(--stipe-fg-muted)">
                              Changes still copying to your files
                            </span>
                          ) : null}
                          {process.cwd === null ? null : (
                            <span className="block truncate text-xs font-normal text-(--stipe-fg-muted)">
                              {process.cwd}
                            </span>
                          )}
                        </>
                      )}
                    </>
                  }
                  actions={
                    <>
                      {processOutput ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Show output of ${process.command}`}
                          onClick={() => {
                            processOutput.select(process.id);
                          }}
                        >
                          Output
                        </Button>
                      ) : null}
                      {preview ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Open preview of port ${String(preview.port)}`}
                          onClick={() => {
                            openPreview(preview);
                          }}
                        >
                          <ArrowUpRight size={14} aria-hidden="true" /> Open
                        </Button>
                      ) : null}
                      {process.state === "running" && onStopProcess ? (
                        <HoldButton
                          holdHint="A stopped process cannot be resumed. Press and hold to stop it."
                          size="xs"
                          variant="ghost"
                          className="hover:text-error"
                          disabled={action === "stopping"}
                          aria-label={`Stop process ${process.command}`}
                          onPointerDown={() => {
                            pressedAt.current = Date.now();
                            setHoldHintFor(null);
                          }}
                          onPointerUp={() => {
                            noteRelease(process.id);
                          }}
                          onConfirm={() => {
                            setHoldHintFor(null);
                            void onStopProcess(process.id);
                          }}
                        >
                          {action === "stopping" ? "Stopping…" : "Stop"}
                        </HoldButton>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </AnimatedInventoryList>
        </div>
        {processLoading ? (
          <p className="mt-2 text-xs text-base-content/60" role="status">
            Refreshing processes…
          </p>
        ) : null}
        {processError !== null ? (
          <p className="mt-2 text-xs text-error" role="status">
            Couldn't refresh processes. The list may be out of date.
          </p>
        ) : null}
      </>
    );
  })();
  return (
    <div className="space-y-6 p-4 sm:p-6">
      {runtimeReason ? (
        <p role="status" className="px-2 pt-3 text-sm">
          {runtimeReason}
        </p>
      ) : null}
      {onStartProcess &&
      (processError === null || processError.reason === "failed") ? (
        <startForm.form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <SchemaForm
              model={startForm}
              aria-label="Start a process"
              className="mt-3 px-2"
              disabled={submitting || runtimeReason !== undefined}
              footer={
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    loading={submitting}
                    disabled={submitting || runtimeReason !== undefined}
                    onClick={() => {
                      startForm.form.setFieldMeta("command", (meta) => ({
                        ...meta,
                        errorMap: {
                          ...meta.errorMap,
                          onServer: undefined,
                        },
                      }));
                    }}
                  >
                    Start
                  </Button>
                </div>
              }
            >
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <FormFields
                  model={startForm}
                  disabled={submitting || runtimeReason !== undefined}
                />
              </div>
            </SchemaForm>
          )}
        </startForm.form.Subscribe>
      ) : null}
      {processOutput?.processId ? (
        <section aria-label="Process output" className="mt-3 space-y-2 px-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">
              {processOutput.data?.process.command ?? "Process output"}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                processOutput.select(null);
              }}
            >
              Close output
            </Button>
          </div>
          {processOutput.failed ? (
            <p role="status">Couldn't read output. Try opening it again.</p>
          ) : processOutput.loading ? (
            <Loader size="sm" label="Loading output" />
          ) : (
            <>
              <Screen>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap p-3 text-xs">
                  {processOutput.data?.lines.length === 0
                    ? "No output yet."
                    : processOutput.data?.lines.join("\n")}
                </pre>
              </Screen>
              {processOutput.data?.process.exitCode != null ? (
                <p className="text-xs">
                  Exit {processOutput.data.process.exitCode}
                </p>
              ) : null}
              {processOutput.data?.truncated ? (
                <p className="text-xs">Showing the most recent output.</p>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      <section aria-label="Process history" className="space-y-3">
        <h2 className="px-2 text-sm font-semibold">History</h2>
        {processContent}
      </section>
    </div>
  );
}

/** The same controls in the persistent exec-only main pane. */
export function ShedProcessPanel(props: ShedProcessPanelProps) {
  return useShedProcessPanel(props);
}
