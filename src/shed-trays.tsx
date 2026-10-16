import {
  computerPortExposureSchema,
  type ComputerPorts,
} from "@fungi.computer/agar/computer";
import {
  StatusTray,
  StatusTrayList,
  StatusTrayNote,
  StatusTrayRow,
  type StatusTrayItem,
} from "@fungi.computer/caps/blocks/status-tray";
import {
  FormFields,
  SchemaForm,
  field,
  useSchemaForm,
} from "@fungi.computer/caps/form";
import { Schema } from "effect";
import { UndoAction } from "@fungi.computer/caps/components/undo-action";
import { HoldButton } from "@fungi.computer/caps/components/hold-button";
import { Button } from "@fungi.computer/caps/components/button";
import { IconButton } from "@fungi.computer/caps/components/icon-button";
import {
  Status,
  type StatusTone,
} from "@fungi.computer/caps/components/status";
import { Input } from "@fungi.computer/caps/components/input";
import { ArrowUpRight, Globe2, RefreshCw, X } from "lucide-react";
import {
  reorderKeyAttribute,
  useListMotion,
} from "@fungi.computer/caps/lib/reorder-motion";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { useShedData } from "./shed-data.js";

export type ShedPreviewPort = ComputerPorts["ports"][number];

const portFields = Schema.Struct({
  port: computerPortExposureSchema.fields.port.annotate(
    field({ label: "Port", min: 1, max: 65_535 }),
  ),
});

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

export type ShedTraysProps = {
  openPreview: (port: ShedPreviewPort) => void;
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  /** Focus this admitted inventory row for one host-issued navigation. */
  processNavigation?: Readonly<{ requestId: string; processId: string }> | null;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** `host`: the shell's status bar draws the chips; only the open tray shows. */
  placement?: "housing" | "host";
  /** Trays after Ports and Processes, such as Computer access. */
  extraItems?: readonly StatusTrayItem[];
  /** For `host`: where the shell's key sits, so the tray opens above it. */
  hostInset?: number;
};

export function ShedTrays({
  openPreview,
  openId,
  onOpenChange,
  processNavigation = null,
  leading,
  trailing,
  placement = "housing",
  extraItems = [],
  hostInset,
}: ShedTraysProps) {
  const {
    ports: {
      items: ports,
      status: portStatus,
      actions: portActions,
      refresh: onRefreshPorts,
      expose: onExposePort,
      unexpose: onUnexposePort,
    },
    processes: {
      items: processes,
      loading: processLoading,
      error: processError,
      actions: processActions,
      refresh: onRefreshProcesses,
      stop: onStopProcess,
      start: onStartProcess,
    },
  } = useShedData();
  const processList = useRef<HTMLDivElement>(null);
  const focusedRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      openId !== "processes" ||
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
  }, [openId, processNavigation, processes]);
  const portForm = useSchemaForm({
    schema: portFields,
    defaultValues: { port: 5173 },
    onSubmit: async ({ port }) =>
      (await onExposePort?.(port))
        ? { kind: "saved" }
        : {
            kind: "refused",
            fields: {
              port: `Couldn't expose port ${String(port)}. Try again.`,
            },
          },
  });
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
  const clearPortRefusal = () => {
    portForm.form.setFieldMeta("port", (meta) => ({
      ...meta,
      errorMap: { ...meta.errorMap, onServer: undefined },
    }));
  };
  const retryPort = async (port: number) => {
    if (
      (await onExposePort?.(port)) &&
      portForm.form.state.values.port === port
    )
      clearPortRefusal();
  };
  const portCount = ports?.length ?? 0;
  const portRows = new Map<number, ShedPreviewPort | null>();
  for (const port of ports ?? []) portRows.set(port.port, port);
  for (const [port, action] of portActions ?? []) {
    if (action.expose && !portRows.has(port)) portRows.set(port, null);
  }
  const processesAvailable =
    processes !== null || processLoading || processError;
  const portContent = (() => {
    if (portStatus === "not-configured") {
      return (
        <StatusTrayNote title="Preview service isn't configured">
          You can still work in the terminal.
        </StatusTrayNote>
      );
    }
    if (ports === null && portStatus === "unavailable") {
      return (
        <StatusTrayNote title="Port listing isn't available">
          You can still work in the terminal.
        </StatusTrayNote>
      );
    }
    if (ports === null && portStatus === "loading") {
      return (
        <StatusTrayNote title="Loading exposed ports">
          Checking which ports this Computer has exposed.
        </StatusTrayNote>
      );
    }
    if (ports === null && portStatus === "error") {
      return (
        <StatusTrayNote title="Couldn't load exposed ports">
          Check the Computer connection, then refresh to try again.
        </StatusTrayNote>
      );
    }
    return (
      <>
        {portRows.size > 0 ? (
          <AnimatedTrayList
            label="Exposed ports"
            order={Array.from(portRows.keys(), String)}
          >
            {Array.from(portRows, ([port, preview]) => {
              const action = portActions?.get(port);
              const pending = action?.status === "pending";
              const failure =
                action?.status === "failed"
                  ? action.expose
                    ? `Couldn't expose port ${String(port)}. Try again.`
                    : "Couldn't remove exposure. Try again."
                  : null;
              return (
                <StatusTrayRow
                  key={port}
                  {...{ [reorderKeyAttribute]: String(port) }}
                  role="listitem"
                  data-shed-port={port}
                  icon={<Globe2 size={16} aria-hidden="true" />}
                  primary={
                    failure ? (
                      <>
                        <span className="block">Port {port}</span>
                        <span
                          role="status"
                          className="block whitespace-normal text-xs font-normal text-error"
                        >
                          {failure}
                        </span>
                      </>
                    ) : (
                      `Port ${String(port)}`
                    )
                  }
                  actions={
                    preview ? (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => {
                            openPreview(preview);
                          }}
                          aria-label={`Open preview of port ${String(port)}`}
                        >
                          <ArrowUpRight size={14} aria-hidden="true" />
                          Open preview
                        </Button>
                        <UndoAction
                          aria-label={`Stop exposing port ${String(port)}`}
                          armedAnnouncement={`Port ${String(port)} closes in 5 seconds.`}
                          undoneAnnouncement={`Port ${String(port)} stays open.`}
                          size="xs"
                          variant="ghost"
                          className="hover:text-error"
                          disabled={!onUnexposePort || pending}
                          onCommit={() => {
                            void onUnexposePort?.(port);
                          }}
                        >
                          {pending
                            ? action.expose
                              ? "Exposing…"
                              : "Removing…"
                            : "Remove exposure"}
                        </UndoAction>
                      </>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!onExposePort || pending}
                        aria-label={`Expose port ${String(port)}`}
                        onClick={() => {
                          void retryPort(port);
                        }}
                      >
                        {pending ? "Exposing…" : "Try again"}
                      </Button>
                    )
                  }
                />
              );
            })}
          </AnimatedTrayList>
        ) : (
          <StatusTrayNote
            title={
              portStatus === "error"
                ? "Couldn't load exposed ports"
                : "No exposed ports"
            }
          >
            {portStatus === "error"
              ? "Check the Computer connection, then refresh to try again."
              : "Expose a port from this Computer to see it here."}
          </StatusTrayNote>
        )}
        <portForm.form.Subscribe
          selector={(state) => ({
            submitting: state.isSubmitting,
            port: state.values.port,
          })}
        >
          {({ submitting, port }) => {
            const busy =
              submitting || portActions?.get(port)?.status === "pending";
            const disabled = onExposePort === undefined || busy;
            return (
              <SchemaForm
                model={portForm}
                className="mt-3 px-2"
                aria-label="Expose a port"
                disabled={disabled}
                footer={null}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <FormFields model={portForm} disabled={disabled} />
                  </div>
                  <Button
                    className="self-end"
                    type="submit"
                    size="sm"
                    disabled={disabled}
                    loading={busy}
                    onClick={clearPortRefusal}
                  >
                    Expose
                  </Button>
                </div>
              </SchemaForm>
            );
          }}
        </portForm.form.Subscribe>
        {portStatus === "loading" && ports !== null ? (
          <p className="mt-2 text-xs text-base-content/60" role="status">
            Refreshing exposed ports…
          </p>
        ) : null}
        {portStatus === "error" && ports !== null ? (
          <p className="mt-2 text-xs text-error" role="status">
            Couldn't refresh exposed ports. The list may be out of date.
          </p>
        ) : null}
      </>
    );
  })();
  const processContent = (() => {
    if (!processesAvailable)
      return (
        <StatusTrayNote title="Processes can't be listed yet">
          You can still run things in the terminal.
        </StatusTrayNote>
      );
    if (processLoading && processes === null)
      return (
        <StatusTrayNote title="Loading processes">
          Checking this Computer's process inventory.
        </StatusTrayNote>
      );
    if (processError && processes === null)
      return (
        <StatusTrayNote title="Couldn't load processes">
          Check the Computer connection, then refresh to try again.
        </StatusTrayNote>
      );
    if (processes === null || processes.length === 0)
      return (
        <StatusTrayNote title="No processes">
          This Computer reports no retained processes.
        </StatusTrayNote>
      );
    return (
      <>
        <AnimatedTrayList
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
            let tone: StatusTone = "neutral";
            if (process.state === "running") tone = "success";
            else if (process.state === "uncertain") tone = "warning";
            // Files a command wrote may still be mid-flight to the Workspace;
            // say so calmly next to the exit, not as an error on the exit.
            const filesNotSyncedYet =
              process.state === "exited" && process.sync === "pending";
            return (
              <StatusTrayRow
                key={process.id}
                {...{ [reorderKeyAttribute]: process.id }}
                role="listitem"
                data-process-state={process.state}
                data-process-sync={process.sync}
                tabIndex={-1}
                primary={
                  <>
                    <span className="block truncate" data-process-command>
                      {process.command}
                    </span>
                    <span className="flex items-center gap-2 text-xs font-normal">
                      <Status
                        size="compact"
                        tone={tone}
                        label={
                          action === "stopping" ? "stopping" : process.state
                        }
                      />
                      {filesNotSyncedYet ? (
                        <Status
                          size="compact"
                          tone="warning"
                          glyph="dot"
                          label="Files not synced yet"
                        />
                      ) : null}
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
                      <span className="block truncate text-xs font-normal text-base-content/60">
                        {`${process.cwd ?? "Unknown directory"} · ${process.id}${process.state === "exited" && process.exitCode !== null ? ` · Exit ${String(process.exitCode)}` : ""}`}
                      </span>
                    )}
                  </>
                }
                actions={
                  <>
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
                        onConfirm={() => {
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
        </AnimatedTrayList>
        {processLoading ? (
          <p className="mt-2 text-xs text-base-content/60" role="status">
            Refreshing processes…
          </p>
        ) : null}
        {processError ? (
          <p className="mt-2 text-xs text-error" role="status">
            Couldn't refresh processes. The list may be out of date.
          </p>
        ) : null}
      </>
    );
  })();
  const items: readonly StatusTrayItem[] = [
    {
      id: "ports",
      label: "Ports",
      count: portCount,
      title: "Exposed ports",
      actions: (
        <IconButton
          aria-label="Refresh exposed ports"
          title="Refresh exposed ports"
          icon={<RefreshCw />}
          size="xs"
          iconSize="xs"
          disabled={!onRefreshPorts || portStatus === "loading"}
          onClick={() => {
            void onRefreshPorts?.();
          }}
        />
      ),
      content: portContent,
    },
    {
      id: "processes",
      label: "Processes",
      count: processes?.filter((process) => process.state === "running").length,
      title: "Computer processes",
      disabled: !processesAvailable,
      accessibleLabel: processesAvailable
        ? undefined
        : "Processes can't be listed yet",
      actions: (
        <IconButton
          aria-label="Refresh processes"
          title="Refresh processes"
          icon={<RefreshCw />}
          size="xs"
          iconSize="xs"
          disabled={!onRefreshProcesses || processLoading}
          onClick={() => {
            void onRefreshProcesses?.();
          }}
        />
      ),
      content: (
        <>
          {onStartProcess ? (
            <startForm.form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) => (
                <SchemaForm
                  model={startForm}
                  aria-label="Start a process"
                  className="mb-3 px-2"
                  disabled={submitting}
                  footer={
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      loading={submitting}
                      disabled={submitting}
                      onClick={() => {
                        startForm.form.setFieldMeta("command", (meta) => ({
                          ...meta,
                          errorMap: { ...meta.errorMap, onServer: undefined },
                        }));
                      }}
                    >
                      Start
                    </Button>
                  }
                >
                  <FormFields model={startForm} disabled={submitting} />
                </SchemaForm>
              )}
            </startForm.form.Subscribe>
          ) : null}
          {processContent}
        </>
      ),
    },
    ...extraItems,
  ];
  return (
    <StatusTray
      items={items}
      openId={openId}
      onOpenChange={onOpenChange}
      leading={leading}
      trailing={trailing}
      placement={placement}
      {...(hostInset === undefined ? {} : { hostInset })}
      align={placement === "host" ? "start" : "end"}
    />
  );
}

export function PortPreview({
  port,
  onClose,
  onPopOut,
}: {
  port: ShedPreviewPort;
  onClose: () => void;
  onPopOut: () => void;
}) {
  const [revision, setRevision] = useState(0);
  return (
    <section
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden rounded-field bg-base-100"
      aria-label={`Preview port ${String(port.port)}`}
    >
      <div className="shed-browser-controls flex h-8 shrink-0 items-center gap-1 border-b border-base-300 px-1">
        <span className="min-w-0 flex-1 truncate px-2 font-mono text-xs">
          :{port.port}
        </span>
        <IconButton
          aria-label="Open preview in new window"
          title="Open preview in new window"
          icon={<ArrowUpRight />}
          size="xs"
          iconSize="xs"
          onClick={onPopOut}
        />
        <IconButton
          aria-label="Reload preview"
          title="Reload preview"
          icon={<RefreshCw />}
          size="xs"
          iconSize="xs"
          onClick={() => {
            setRevision((value) => value + 1);
          }}
        />
        <IconButton
          aria-label="Close preview"
          title="Close preview"
          icon={<X aria-hidden="true" />}
          size="xs"
          iconSize="xs"
          onClick={onClose}
        />
      </div>
      <iframe
        key={`${String(port.port)}:${String(revision)}`}
        className="shed-preview-frame block min-h-0 w-full flex-1 border-0 bg-base-100"
        sandbox="allow-scripts allow-same-origin allow-popups"
        src={port.previewUrl}
        title={`Preview · port ${String(port.port)}`}
      />
    </section>
  );
}

function AnimatedTrayList({
  label,
  order,
  children,
  listRoot,
}: {
  label: string;
  order: readonly string[];
  children: ReactNode;
  listRoot?: RefObject<HTMLDivElement>;
}) {
  const localRoot = useRef<HTMLDivElement>(null);
  const root = listRoot ?? localRoot;
  useListMotion(root, order);
  return (
    <div ref={root}>
      <StatusTrayList role="list" aria-label={label}>
        {children}
      </StatusTrayList>
    </div>
  );
}
