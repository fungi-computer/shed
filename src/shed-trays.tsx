import {
  computerPortExposureSchema,
  type ComputerPorts,
} from "@fungi.computer/agar/computer";
import {
  StatusTray,
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
import { Button } from "@fungi.computer/caps/components/button";
import { IconButton } from "@fungi.computer/caps/components/icon-button";
import { ArrowUpRight, Globe2, RefreshCw, X } from "lucide-react";
import { reorderKeyAttribute } from "@fungi.computer/caps/lib/reorder-motion";
import { useState, type ReactNode } from "react";
import { AnimatedInventoryList } from "./inventory-list.js";
import { useShedProcessPanel } from "./shed-process-panel.js";

import { useShedData } from "./shed-data.js";

export type ShedPreviewPort = ComputerPorts["ports"][number];

const portFields = Schema.Struct({
  port: computerPortExposureSchema.fields.port.annotate(
    field({ label: "Port", min: 1, max: 65_535 }),
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
  processesInPane?: boolean;
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
  processesInPane = false,
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
      refresh: onRefreshProcesses,
    },
  } = useShedData();
  const processPanel = useShedProcessPanel({
    openPreview,
    processNavigation: openId === "processes" ? processNavigation : null,
  });
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
    processes !== null || processLoading || processError !== null;
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
          <AnimatedInventoryList
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
          </AnimatedInventoryList>
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
      title: "Processes",
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
      content: processPanel,
    },
    ...extraItems,
  ];
  return (
    <StatusTray
      items={
        processesInPane
          ? items.filter((item) => item.id !== "processes")
          : items
      }
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
