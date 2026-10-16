import {
  registerCatalog,
  type AppContext,
  type AppRoot,
} from "@fungi.computer/agar";
import { useStore, useWindowStatus } from "@fungi.computer/agar/react";
import { useComputerAccessTray } from "./computer-instrument.js";
import type { WhistleCommand } from "@fungi.computer/whistle";
import {
  computerTerminal,
  computerProcessSchema,
} from "@fungi.computer/agar/computer";
import { Option, Schema } from "effect";
import { EmptyState } from "@fungi.computer/caps/blocks/empty-state";
import { Button } from "@fungi.computer/caps/components/button";
import { ResizeHandle } from "@fungi.computer/caps/components/resize-handle";
import {
  MaosaicoRoot,
  useMaosaicoItem,
  useMaosaicoLayout,
} from "@fungi.computer/maosaico";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShedProcesses } from "./shed-processes.js";
import { useShedPorts } from "./shed-ports.js";
import { ShedDataContext, useShedData } from "./shed-data.js";
import type { TerminalState } from "./terminal-panel.js";
import { ShellPanel } from "./light-shell/shell-panel.js";
import { Sigil } from "@fungi.computer/sigils";
import {
  PortPreview,
  ShedTrays,
  type ShedPreviewPort,
  type ShedTraysProps,
} from "./shed-trays.js";

const readProcessId = Schema.decodeUnknownOption(
  computerProcessSchema.fields.id,
);

export type ShedAppConnection = Pick<
  AppRoot,
  "capabilities" | "commands" | "context" | "ui"
>;

export type ConnectedApp = ShedAppConnection & Pick<AppRoot, "identity">;

export function ShedApp({ app }: { app: ConnectedApp | null }) {
  const appContext = useStore(app?.context) ?? null;
  return (
    <ShedWorkspace
      key={JSON.stringify([app?.identity.surfaceId, appContext?.computerId])}
      app={app}
      appContext={appContext}
    />
  );
}

function ShedWorkspace({
  app,
  appContext,
}: {
  app: ConnectedApp | null;
  appContext: AppContext | null;
}) {
  const computerId = appContext?.computerId ?? null;
  const {
    query: portQuery,
    ports,
    status: portStatus,
    actions: portActions,
    enabled: canListPorts,
    change: changePort,
  } = useShedPorts(app, appContext?.visibility === "visible");
  const refreshPorts = useCallback(async () => {
    await portQuery.refetch();
  }, [portQuery.refetch]);
  const {
    query: processQuery,
    stop: stopProcess,
    startCommand,
    actions: processActions,
    enabled: canListProcesses,
  } = useShedProcesses(app, appContext?.visibility === "visible");
  const refreshProcesses = useCallback(async () => {
    await processQuery.refetch();
  }, [processQuery.refetch]);
  const commandActions = useRef({ refreshPorts, refreshProcesses });
  commandActions.current = { refreshPorts, refreshProcesses };
  useEffect(() => {
    if (!app) return;
    return registerCatalog(
      app.commands,
      shedCommands(
        () => commandActions.current.refreshPorts(),
        () => commandActions.current.refreshProcesses(),
      ),
    );
  }, [app]);

  if (appContext?.teamHasComputers === false)
    return (
      <NoTeamComputersState
        onAllowAccess={
          app && !appContext.computerAccessGranted
            ? () =>
                void app.ui
                  .requestAppPermissions({ computers: ["computer.execute"] })
                  .catch((cause: unknown) => {
                    console.error("Shed Computer operation failed", cause);
                    return undefined;
                  })
            : undefined
        }
      />
    );

  return (
    <ShedDataContext.Provider
      value={{
        ports: {
          items: ports,
          status: portStatus,
          actions: portActions,
          refresh: canListPorts ? refreshPorts : undefined,
          expose: canListPorts ? (port) => changePort(port, true) : undefined,
          unexpose: canListPorts
            ? (port) => {
                void changePort(port, false);
              }
            : undefined,
        },
        processes: {
          items: canListProcesses
            ? (processQuery.data?.processes ?? null)
            : null,
          loading: canListProcesses && processQuery.isFetching,
          error: canListProcesses && processQuery.isError,
          actions: processActions,
          refresh: canListProcesses ? refreshProcesses : undefined,
          start: canListProcesses ? startCommand : undefined,
          stop: canListProcesses
            ? (id) => {
                stopProcess.mutate(id);
              }
            : undefined,
        },
      }}
    >
      <ShedWorkspaceView
        key={computerId}
        app={app}
        computerId={computerId}
        computerAccessGranted={appContext?.computerAccessGranted === true}
      />
    </ShedDataContext.Provider>
  );
}

export function NoTeamComputersState({
  onAllowAccess,
}: {
  onAllowAccess?: () => void;
}) {
  return (
    <main className="grid h-full min-h-0 grid-cols-1 place-items-center bg-base-200 p-6 text-base-content">
      <EmptyState
        className="w-full max-w-[460px]"
        data-absence="team-computers-empty"
        variant="panel"
        visual={
          <span className="inline-grid size-16 place-items-center rounded-full bg-base-200 text-primary">
            <Sigil name="computer" size={48} />
          </span>
        }
        title="No Computer yet."
        description={
          onAllowAccess
            ? "No Computer is attached to this window. Allow Computer access to use one here."
            : "No Computer is attached to this window."
        }
        actions={
          onAllowAccess ? (
            <Button size="sm" onClick={onAllowAccess}>
              Allow Computer access
            </Button>
          ) : null
        }
      />
    </main>
  );
}

function shedCommands(
  refreshPorts: () => Promise<void>,
  refreshProcesses: () => Promise<void>,
): readonly WhistleCommand<never>[] {
  return [
    {
      id: "refresh-processes",
      title: "Refresh processes",
      category: "Computer",
      description: "Refresh the running processes on this Computer.",
      projections: { palette: {} },
      handler: refreshProcesses,
    },
    {
      id: "refresh-ports",
      title: "Refresh forwarded ports",
      category: "Computer",
      description: "Refresh the forwarded ports on this Computer.",
      projections: { palette: {} },
      handler: refreshPorts,
    },
  ];
}

/**
 * Workspace presentation. Computer/Agar owns port admission; Ladle supplies fixtures.
 */
export function ShedWorkspaceView({
  app,
  computerId,
  computerAccessGranted = false,
}: ShedWorkspaceViewProps) {
  const workspace = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setBounds({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const terminalAvailable =
    computerId !== null && app?.capabilities.has(computerTerminal) === true;
  const {
    ports: { items: ports, status: portStatus },
    processes: {
      items: processes,
      loading: processLoading,
      error: processError,
    },
  } = useShedData();
  const [openTray, setOpenTray] = useState<string | null>(null);
  const openRequest = useStore(app?.context)?.openRequest ?? null;
  const handledOpenRequest = useRef<string | null>(null);
  const [processNavigation, setProcessNavigation] = useState<NonNullable<
    ShedTraysProps["processNavigation"]
  > | null>(null);
  useEffect(() => {
    if (
      computerId === null ||
      openRequest?.kind !== "navigate" ||
      handledOpenRequest.current === openRequest.requestId
    )
      return;
    const values = openRequest.params.filter(({ key }) => key === "process");
    if (values.length !== 1) return;
    const processId = Option.getOrNull(readProcessId(values[0]?.value));
    if (processId === null) return;
    handledOpenRequest.current = openRequest.requestId;
    setProcessNavigation({ requestId: openRequest.requestId, processId });
    setOpenTray("processes");
  }, [computerId, openRequest]);
  const [trayInset, setTrayInset] = useState<number | undefined>(undefined);
  const [previewPort, setPreviewPort] = useState<number | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [terminal, setTerminal] = useState<{
    computerId: string;
    name: string | null;
    state: TerminalState;
  } | null>(null);
  const onTerminalStatus = useCallback(
    (status: { name: string | null; state: TerminalState }) => {
      if (computerId !== null) setTerminal({ ...status, computerId });
    },
    [computerId],
  );
  const terminalNow =
    terminalAvailable && terminal?.computerId === computerId ? terminal : null;
  const narrow = bounds.width < 540;
  const preview = ports?.find((port) => port.port === previewPort) ?? null;
  const openPreview = (port: ShedPreviewPort) => {
    if (port.openMode === "external-only") {
      window.open(port.previewUrl, "_blank", "noopener,noreferrer");
      return;
    }
    setPreviewPort(port.port);
    setPreviewVisible(true);
    setOpenTray(null);
  };
  const processesAvailable =
    processes !== null || processLoading || processError;
  const accessTray = useComputerAccessTray({
    app,
    terminal: terminalNow,
    processes: processError
      ? { kind: "error" }
      : processes !== null
        ? { kind: "loaded", count: processes.length }
        : processLoading
          ? { kind: "loading" }
          : { kind: "unavailable" },
    ports:
      portStatus === "error"
        ? { kind: "error" }
        : portStatus === "loaded" && ports !== null
          ? { kind: "loaded", count: ports.length }
          : portStatus === "loading"
            ? { kind: "loading" }
            : { kind: "unavailable" },
  });
  // Shed's one bottom bar is the shell's window status bar: Shed declares its
  // terminal state, trays and Access there and answers their clicks here.
  useWindowStatus(
    app,
    computerId === null
      ? []
      : [
          ...(terminalNow
            ? [
                {
                  kind: "text" as const,
                  id: "terminal",
                  text: `Terminal ${terminalNow.state}`,
                  tone: terminalTone(terminalNow.state),
                },
              ]
            : terminalAvailable
              ? []
              : [
                  {
                    kind: "text" as const,
                    id: "terminal",
                    text: "Terminal unavailable",
                    tone: "warning" as const,
                  },
                ]),
          ...(portStatus === "not-configured"
            ? []
            : [
                {
                  kind: "button" as const,
                  id: "ports",
                  text: "Ports",
                  icon: "ports" as const,
                  count: ports?.length ?? 0,
                  opens: "dialog" as const,
                  expanded: openTray === "ports",
                },
              ]),
          {
            kind: "button" as const,
            id: "processes",
            text: "Processes",
            icon: "processes" as const,
            opens: "dialog" as const,
            expanded: openTray === "processes",
            count:
              processes?.filter((process) => process.state === "running")
                .length ?? 0,
            disabled: !processesAvailable,
            title: processesAvailable
              ? "Processes on this Computer"
              : "Processes can't be listed yet",
          },
          ...(narrow && preview
            ? [
                {
                  kind: "toggle" as const,
                  id: "screen",
                  text: `:${String(preview.port)}`,
                  pressed: previewVisible,
                },
              ]
            : []),
          {
            kind: "button" as const,
            id: "access",
            text: "Access",
            icon: "access" as const,
            opens: "dialog" as const,
            expanded: openTray === "access",
            title: terminalAvailable
              ? "Shed can run commands on this Computer"
              : "Shed can't run commands on this Computer",
          },
        ],
    (action) => {
      if (action.itemId === "screen") {
        setPreviewVisible((visible) => !visible);
        return true;
      }
      if (["ports", "processes", "access"].includes(action.itemId)) {
        // The tray opens above the key the person used in the shell's bar.
        setTrayInset(action.anchor?.start);
        setOpenTray((open) => (open === action.itemId ? null : action.itemId));
        return true;
      }
      return false;
    },
  );
  return (
    <main
      className="shed-workspace flex h-full min-h-0 w-full flex-col overflow-hidden bg-base-200 font-sans text-base-content"
      aria-label="Shed Computers workspace"
    >
      <div ref={workspace} className="relative min-h-0 flex-1">
        <MaosaicoRoot
          bounds={bounds}
          tiling={{
            axis: "y",
            mainSize: bounds.width >= 540 ? bounds.height * 0.5 : bounds.height,
            gap: 8,
          }}
        >
          <ShedLayout
            app={app}
            computerId={computerId}
            computerAccessGranted={computerAccessGranted}
            terminalAvailable={terminalAvailable}
            bounds={bounds}
            narrow={narrow}
            preview={preview}
            previewVisible={previewVisible}
            onClosePreview={() => {
              setPreviewVisible(false);
              setPreviewPort(null);
            }}
            onTerminalStatus={onTerminalStatus}
          />
        </MaosaicoRoot>
      </div>
      {computerId === null ? null : (
        <ShedTrays
          placement="host"
          openPreview={openPreview}
          openId={openTray}
          onOpenChange={setOpenTray}
          processNavigation={processNavigation}
          extraItems={[accessTray]}
          {...(trayInset === undefined ? {} : { hostInset: trayInset })}
        />
      )}
    </main>
  );
}

export type ShedWorkspaceViewProps = {
  app: ShedAppConnection | null;
  computerId: string | null;
  computerAccessGranted?: boolean;
};

function ShedLayout({
  app,
  computerId,
  computerAccessGranted,
  terminalAvailable,
  bounds,
  narrow,
  preview,
  previewVisible,
  onClosePreview,
  onTerminalStatus,
}: ShedWorkspaceViewProps & {
  terminalAvailable: boolean;
  bounds: { width: number; height: number };
  narrow: boolean;
  preview: ShedPreviewPort | null;
  previewVisible: boolean;
  onClosePreview: () => void;
  onTerminalStatus: (status: {
    name: string | null;
    state: TerminalState;
  }) => void;
}) {
  const layout = useMaosaicoLayout();
  const showSplitPreview = preview !== null && previewVisible && !narrow;
  const previewPaneOrdered = useRef(false);
  useEffect(() => {
    if (!showSplitPreview) {
      previewPaneOrdered.current = false;
      return;
    }
    if (previewPaneOrdered.current) return;
    previewPaneOrdered.current = true;
    requestAnimationFrame(() => {
      layout.swap("terminal", "preview");
    });
  }, [layout, showSplitPreview]);
  const closePreview = () => {
    onClosePreview();
    if (layout.zoomedId === "preview") layout.zoom(null);
  };
  const popOutPreview = () => {
    if (preview)
      window.open(preview.previewUrl, "_blank", "noopener,noreferrer");
  };
  return (
    <>
      {showSplitPreview ? (
        <ShedPane id="preview">
          <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
            <PortPreview
              port={preview}
              onClose={closePreview}
              onPopOut={popOutPreview}
            />
          </div>
        </ShedPane>
      ) : null}
      <ShedPane id="terminal">
        <section
          className="flex h-full min-h-0 w-full flex-col overflow-hidden"
          aria-label="Terminal"
        >
          {computerId !== null && app && terminalAvailable ? (
            <ShellPanel
              key={computerId}
              app={app}
              computerId={computerId}
              onStatusChange={onTerminalStatus}
              screen={
                narrow && preview && previewVisible ? (
                  <PortPreview
                    port={preview}
                    onClose={closePreview}
                    onPopOut={popOutPreview}
                  />
                ) : undefined
              }
            />
          ) : (
            <>
              <EmptyState
                className="grid min-h-0 flex-1 content-center justify-items-center p-4 text-center"
                data-absence={
                  computerId ? "terminal-permission" : "computer-context"
                }
                role="status"
                variant="hint"
                title={
                  computerId ? "Terminal unavailable" : "No Computer selected"
                }
                description={
                  computerId
                    ? "Shed can’t run commands on this Computer yet. Allow Computer access in the window controls."
                    : computerAccessGranted
                      ? "No Computer is attached to this window."
                      : "No Computer is attached to this window. Allow Computer access to use one here."
                }
                actions={
                  app && computerId === null && !computerAccessGranted ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        void app.ui
                          .requestAppPermissions({
                            computers: ["computer.execute"],
                          })
                          .catch((cause: unknown) => {
                            console.error(
                              "Shed Computer operation failed",
                              cause,
                            );
                            return undefined;
                          })
                      }
                    >
                      Allow Computer access
                    </Button>
                  ) : null
                }
              />
            </>
          )}
        </section>
      </ShedPane>
      {showSplitPreview ? (
        <div
          className="absolute inset-x-0 z-20 -translate-y-1/2"
          style={{
            top: (layout.divider?.position ?? bounds.height / 2) + 8,
          }}
        >
          {layout.divider ? (
            <ResizeHandle
              className="absolute left-1/2 -translate-x-1/2"
              aria-label="Preview and terminal size"
              orientation="horizontal"
              variant="notch"
              value={layout.divider.position}
              min={layout.divider.min}
              max={layout.divider.max}
              onValueChange={layout.resizeMain}
              onDoubleClick={() => {
                layout.resizeMain(bounds.height / 2);
              }}
              {...layout.divider.props}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function ShedPane({
  id,
  children,
}: {
  id: "preview" | "terminal";
  children: ReactNode;
}) {
  const pane = useMaosaicoItem({
    id,
    frame: { x: 0, y: 0, width: 560, height: 180 },
    minima: { width: 240, height: id === "preview" ? 140 : 120 },
  });
  return (
    <div
      className="shed-pane absolute flex min-h-0 min-w-0 p-1"
      data-shed-pane={id}
      hidden={!pane.visible}
      style={{
        left: pane.frame.x,
        top: pane.frame.y,
        width: pane.frame.width,
        height: pane.frame.height,
      }}
    >
      {children}
    </div>
  );
}

function terminalTone(
  state: TerminalState,
): "success" | "error" | "warning" | "neutral" {
  if (state === "open") return "success";
  if (state === "failed") return "error";
  if (state === "starting") return "warning";
  return "neutral";
}
