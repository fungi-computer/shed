import type { AppContext, AppRoot } from "@fungi.computer/agar";
import { createCapabilityRegistry } from "@fungi.computer/agar";
import { computerTerminal } from "@fungi.computer/agar/computer";

type ShedConnection = Pick<
  AppRoot,
  "capabilities" | "commands" | "context" | "ui"
>;

/** Visual review never grants anything; host affordances decline politely. */
const previewUi: AppRoot["ui"] = {
  requestAppPermissions: () => Promise.resolve("declined"),
  openNavigation: () => Promise.resolve(),
  reportStatus: () => Promise.resolve(),
  onStatusAction: () => () => undefined,
  openTeamBilling: () => Promise.resolve(),
  requestComputerChoice: () => Promise.reject(new Error("No picker")),
  requestBrowserAction: () => {
    throw new Error("Unexpected browser action");
  },
  openDesktopSettings: () => Promise.resolve(),
  reportAgentSessionSelection: () => Promise.resolve(),
  showToast: () => Promise.resolve(),
};

/** A local stream for visual review. It echoes input; it never executes commands. */
function previewTerminal() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const output = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
      next.enqueue(
        encoder.encode(
          "Shed visual preview — local terminal fixture\r\n" +
            "No Computer commands run from this page.\r\n\r\n$ ",
        ),
      );
    },
    cancel() {
      closed = true;
    },
  });
  const input = new WritableStream<Uint8Array>({
    write(chunk) {
      if (!closed) controller?.enqueue(chunk);
    },
  });
  const close = () => {
    if (closed) return;
    closed = true;
    controller?.close();
  };
  return {
    information: () =>
      Promise.resolve({
        computerName: "Workbench",
        teamName: "Preview Team",
        modelDoor: "Workbench",
        uptimeSeconds: 0,
        version: "workbench",
      }),
    output: () => Promise.resolve(output),
    input: () => Promise.resolve(input),
    resize: () => Promise.resolve(),
    close: () => {
      close();
      return Promise.resolve();
    },
    [Symbol.dispose]: close,
  };
}

export function createShedFixture({
  selected = true,
  terminal = true,
  terminalState = "open",
  status,
}: {
  selected?: boolean;
  terminal?: boolean;
  terminalState?: "open" | "connecting" | "failed" | "closed";
  /** The window's status bar; a story without a shell drops its items. */
  status?: Pick<AppRoot["ui"], "reportStatus" | "onStatusAction">;
} = {}) {
  let context: AppContext = {
    computerId: selected ? "Workbench" : null,
    focus: { editing: false, surface: null },
    visibility: "visible",
    openRequest: null,
  };
  const listeners = new Set<(value: AppContext) => void>();
  const capabilities = createCapabilityRegistry();
  if (terminal)
    capabilities.provide(computerTerminal, {
      open: () => {
        if (terminalState === "connecting") return new Promise(() => undefined);
        if (terminalState === "failed")
          return Promise.reject(
            new Error(
              "The Computer disconnected before the terminal could open.",
            ),
          );
        const session = previewTerminal();
        if (terminalState === "closed") session[Symbol.dispose]();
        return Promise.resolve(session);
      },
    });
  const app: ShedConnection = {
    ui: status ? { ...previewUi, ...status } : previewUi,
    commands: { register: () => Promise.resolve(() => undefined) },
    capabilities,
    context: {
      get: () => context,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return {
    app,
    selectComputer(computerId: string | null) {
      context = { ...context, computerId };
      listeners.forEach((listener) => {
        listener(context);
      });
    },
  };
}
