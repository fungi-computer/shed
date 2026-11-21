import { resultRows } from "@fungi.computer/agar/method-presentation";
import { processesGill } from "./gills.js";
import {
  processPageInputSchema,
  processPageSchema,
  processInventorySchema,
  pageProcesses,
} from "./process-page.js";
import { observeProcess } from "./observation.js";
import { runObservationSchema } from "@fungi.computer/agar/run-observation";
import * as z from "zod";
import { computerRefusalMessage } from "@fungi.computer/agar/computer-contracts";
import { Base64 } from "effect/encoding";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";
import {
  runShedCommand,
  computerCall,
  shedRunCommandInputSchema,
  shedRunInputSchema,
  shedRequestIdSchema,
  shedStartInputSchema,
  type ShedComputer,
  type ShedRuns,
} from "./runs.js";
import {
  runCommandInputSchema,
  runCommandResultSchema,
  shedComputerRefusalSchema,
} from "../src/light-shell/run-command-contract.js";
import {
  defineAppBackend,
  defineAppMethod,
} from "@fungi.computer/agar/backend-definition";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import {
  computerPortsOutputSchema,
  computerProcessSchema,
  processIdInputSchema,
  processKillOutputSchema,
} from "@fungi.computer/computer-contract";
const empty = z.strictObject({});
const command = runCommandInputSchema;
const refusal = shedComputerRefusalSchema;
const portsReply = z.union([computerPortsOutputSchema, refusal]);
const processesReply = z.union([processPageSchema, refusal]);
const inventoryReply = z.union([processInventorySchema, refusal]);
const commandReply = runCommandResultSchema;
/** Only scoped inventory and execution bindings enter this runtime-neutral definition. */
export type ShedMethodContext = Readonly<{
  runs?: ShedRuns;
  env: Readonly<{
    COMPUTER: ShedComputer &
      Readonly<{
        ports(input: Record<string, never>): Promise<WhistleJsonValue>;
        preview(input: { port: number }): Promise<z.core.util.JSONType>;
        processKill(
          input: z.output<typeof processIdInputSchema>,
        ): Promise<z.core.util.JSONType>;
        read(input: {
          path: string;
          byteOffset: number;
          byteLength: number;
        }): Promise<z.core.util.JSONType>;
        exec(input: z.output<typeof command>): Promise<WhistleJsonValue>;
      }>;
  }>;
}>;
const preview = z.strictObject({
  previewUrl: z.url(),
});
const bytes = z.strictObject({
  path: z.string(),
  byteOffset: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.literal("base64"),
  truncated: z.boolean(),
});
/**
 * The Computer binding takes its replay key from the host when the host
 * attested one. Only a caller the host attested none for, such as a key over
 * MCP, sends its own request id along.
 */
const nativeRequestId = (hostKey: string | undefined, requestKey: string) =>
  hostKey === undefined ? requestKey : undefined;
/** The script's command lines, without blanks and comments. */
const commandLines = (command: string) =>
  command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
/**
 * A script reads by its last command: a script usually opens with setup
 * (`set -eu`, `cd`) and ends with what it is for, such as a push.
 */
const lastCommand = (command: string) =>
  commandLines(command).at(-1)?.slice(0, 80) ?? "a command";
const scriptLength = (command: string) => {
  const lines = commandLines(command).length;
  return lines > 1 ? [`${String(lines)} commands`] : [];
};

const maximumLogWindow = 131072;
/** One bounded read of a log, checked against what was asked for. */
async function readLogWindow(
  computer: ShedMethodContext["env"]["COMPUTER"],
  path: string,
  offset: number,
  length: number,
) {
  const reply = bytes.parse(
    await computer.read({ path, byteOffset: offset, byteLength: length }),
  );
  const decoded = Base64.decode(reply.content);
  if (
    reply.path !== path ||
    reply.byteOffset !== offset ||
    decoded._tag === "Failure" ||
    decoded.success.byteLength > length
  )
    throw new Error("Invalid Computer log reply");
  return { reply, byteLength: decoded.success.byteLength };
}

export const appBackend = defineAppBackend<ShedMethodContext>({
  gills: [processesGill],
  methods: {
    expose: defineAppMethod({
      description:
        "Get an admitted preview URL for a port already exposed on the pinned Computer.",
      effect: "write",
      label: "Open a preview of your app",
      requires: ["computer.execute"],
      input: computerPortInputSchema,
      output: preview,
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId)
          throw new Error("Computer preview access is not granted");
        // Project the preview URL; preview-row presentation policy stays with the host.
        return z
          .object(preview.shape)
          .parse(await context.env.COMPUTER.preview(input));
      },
    }),
    logs: defineAppMethod({
      description:
        "Read up to 128 KiB from a log, identified by the process id this caller started or by its host call key; offsets and lengths are bytes.",
      effect: "read",
      requires: ["computer.readFile"],
      input: z
        .strictObject({
          run: z.string().min(1).max(128).optional(),
          id: processIdInputSchema.shape.id.optional(),
          offset: z.number().int().nonnegative().default(0),
          length: z.number().int().min(1).max(131072).default(131072),
        })
        .check(
          z.refine(
            (input) => (input.run === undefined) !== (input.id === undefined),
            "Name the log by run or by id, not both",
          ),
        ),
      output: z.union([
        bytes.extend({
          run: z.string().optional(),
          id: processIdInputSchema.shape.id.optional(),
        }),
        z.strictObject({ error: z.enum(["not_found", "ambiguous"]) }),
      ]),
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId || !context.runs)
          throw new Error("Computer file access is not granted");
        const log =
          input.id !== undefined
            ? context.runs.logPathById(
                input.id,
                caller.computerId,
                caller.actor,
              )
            : input.run === undefined
              ? ({ error: "not_found" } as const)
              : context.runs.logPath(
                  input.run,
                  caller.computerId,
                  caller.actor,
                );
        if ("error" in log) return log;
        const { reply } = await readLogWindow(
          context.env.COMPUTER,
          log.path,
          input.offset,
          input.length,
        );
        return input.id === undefined
          ? { ...reply, run: input.run }
          : { ...reply, id: input.id };
      },
    }),
    observe: defineAppMethod({
      description:
        "Read one process on the attached Computer as a run: its state, why, times, outputs and, for a process this caller started, a log position. Pass the returned log cursor back to advance up to 128 KiB along the log until eof, and read the bytes with logs. Cost is null: no process is metered. Starts nothing.",
      effect: "read",
      requires: ["computer.execute", "computer.readFile"],
      input: z.strictObject({
        id: processIdInputSchema.shape.id,
        cursor: z.number().int().nonnegative().default(0),
      }),
      output: z.union([runObservationSchema, refusal]),
      handler: async (input, context: ShedMethodContext, caller) => {
        if (caller.computerId === null)
          return refusal.parse({ error: "not_granted" });
        const inventory = inventoryReply.parse(
          await computerCall(() => context.env.COMPUTER.processes({})),
        );
        if ("error" in inventory) return inventory;
        const process = inventory.processes.find(
          (item) => item.id === input.id,
        );
        if (process === undefined) return refusal.parse({ error: "not_found" });
        const record =
          context.runs?.recordById(input.id, caller.computerId, caller.actor) ??
          null;
        if (record === null) return observeProcess(process, null, null);
        const { reply, byteLength } = await readLogWindow(
          context.env.COMPUTER,
          record.logPath,
          input.cursor,
          maximumLogWindow,
        );
        const cursor = input.cursor + byteLength;
        return observeProcess(process, record, {
          cursor,
          size: cursor,
          eof: !reply.truncated,
        });
      },
    }),
    start: defineAppMethod({
      description:
        "Start one process on the pinned Computer and return its process and log path without waiting for exit.",
      effect: "write",
      label: "Start a process on your Computer",
      requires: ["computer.execute"],
      pending: true,
      input: shedStartInputSchema,
      output: z.union([
        z.strictObject({
          process: computerProcessSchema,
          logPath: z.string(),
          port: computerPortInputSchema.shape.port.optional(),
        }),
        refusal,
      ]),
      handler: (input, context: ShedMethodContext, caller) => {
        const computer = context.env.COMPUTER;
        if (!caller.computerId || !context.runs)
          throw new Error("Computer access is not granted");
        const requestKey = caller.idempotencyKey ?? input.requestId;
        if (!requestKey)
          throw new Error(
            "A request id or host idempotency key is required to start a process",
          );
        const { processStart, processes } = computer;
        return context.runs.start(
          input,
          caller.computerId,
          requestKey,
          caller.actor,
          { processStart, processes },
          nativeRequestId(caller.idempotencyKey, requestKey),
        );
      },
    }),
    restart: defineAppMethod({
      description:
        "Stop a process this caller started and start its recorded command, directory and port again as a new process linked to it by parentId. Send the same requestId to retry.",
      effect: "write",
      label: "Restart a process on your Computer",
      requires: ["computer.execute"],
      pending: true,
      input: processIdInputSchema.extend({
        requestId: shedRequestIdSchema.optional(),
      }),
      output: z.union([
        z.strictObject({
          process: computerProcessSchema,
          logPath: z.string(),
          port: computerPortInputSchema.shape.port.optional(),
          parentId: processIdInputSchema.shape.id,
        }),
        refusal,
      ]),
      handler: (input, context: ShedMethodContext, caller) => {
        const computer = context.env.COMPUTER;
        if (!caller.computerId || !context.runs)
          throw new Error("Computer access is not granted");
        const requestKey = caller.idempotencyKey ?? input.requestId;
        if (!requestKey)
          throw new Error(
            "A request id or host idempotency key is required to restart a process",
          );
        const { processStart, processes, processKill } = computer;
        return context.runs.restart(
          input.id,
          caller.computerId,
          requestKey,
          caller.actor,
          { processStart, processes, processKill },
          nativeRequestId(caller.idempotencyKey, requestKey),
        );
      },
    }),
    stop: defineAppMethod({
      description: "Signal a retained process on the pinned Computer to stop.",
      effect: "write",
      label: "Stop a process on your Computer",
      requires: ["computer.execute"],
      input: processIdInputSchema,
      output: z.union([processKillOutputSchema, refusal]),
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId)
          throw new Error("Computer access is not granted");
        if (!context.runs?.owns(input.id, caller.computerId, caller.actor))
          return refusal.parse({ error: "not_found" });
        const reply = z
          .union([processKillOutputSchema, refusal])
          .parse(
            await computerCall(() => context.env.COMPUTER.processKill(input)),
          );
        if ("signalled" in reply && reply.signalled)
          context.runs.recordStop(input.id, caller.computerId, caller.actor);
        return reply;
      },
    }),
    run: defineAppMethod({
      description:
        "Run one command on the pinned Computer, retaining a log and polling until it exits.",
      effect: "write",
      label: "Run a command on your Computer",
      requires: ["computer.execute"],
      pending: true,
      input: shedRunInputSchema,
      output: z.union([
        z.strictObject({
          exitCode: z.number().int(),
          logPath: z.string(),
        }),
        refusal,
      ]),
      present: {
        rows: resultRows,
        verb: "ran",
        row: ({ input, output }) =>
          "error" in output
            ? {
                id: "refused",
                title: "Shed could not run the command",
                detail: computerRefusalMessage(output.error),
                tone: "error",
              }
            : {
                id: output.logPath,
                title: `Shed ran ${lastCommand(input.command)}`,
                detail: [
                  output.exitCode === 0
                    ? "Finished"
                    : `Exited with code ${String(output.exitCode)}`,
                  ...scriptLength(input.command),
                ].join(" · "),
                tone: output.exitCode === 0 ? "settled" : "error",
              },
      },
      handler: (input, context: ShedMethodContext, caller) => {
        const computer = context.env.COMPUTER;
        if (!caller.computerId || !context.runs)
          throw new Error("Computer access is not granted");
        const { processStart, processes } = computer;
        const requestKey = caller.idempotencyKey ?? input.requestId;
        if (!requestKey)
          throw new Error(
            "A request id or host idempotency key is required to start a run",
          );
        return context.runs.run(
          input,
          caller.computerId,
          requestKey,
          caller.actor,
          { processStart, processes },
          nativeRequestId(caller.idempotencyKey, requestKey),
        );
      },
    }),

    listPorts: defineAppMethod({
      description:
        "List up to 64 forwarded ports on the attached Computer. This read-only inventory requires computer.execute and starts nothing.",
      effect: "read",
      requires: ["computer.execute"],
      input: empty,
      output: portsReply,
      handler: async (input, context, caller) =>
        caller.computerId === null
          ? refusal.parse({ error: "not_granted" })
          : portsReply.parse(
              await computerCall(() => context.env.COMPUTER.ports(input)),
            ),
    }),
    listProcesses: defineAppMethod({
      description:
        "List up to 64 retained processes on the attached Computer. This read-only inventory requires computer.execute and starts nothing.",
      effect: "read",
      requires: ["computer.execute"],
      input: processPageInputSchema,
      output: processesReply,
      handler: async (input, context, caller) => {
        if (caller.computerId === null)
          return refusal.parse({ error: "not_granted" });
        if (
          input.after !== undefined &&
          input.after.computerId !== caller.computerId
        )
          return refusal.parse({ error: "invalid" });
        const inventory = inventoryReply.parse(
          await computerCall(() => context.env.COMPUTER.processes({})),
        );
        return "error" in inventory
          ? inventory
          : pageProcesses(
              inventory,
              input,
              caller.computerId,
              context.runs?.ownedRecords(caller.computerId, caller.actor) ??
                new Map(),
            );
      },
    }),
    runCommand: defineAppMethod({
      description:
        "Run a shell command on the attached Computer. Use cwd to choose an absolute working directory. The timeout is at most 45 seconds. In a Workflow Git step, use $FUNGI_GIT_REMOTE for the repository. Returns stdout, stderr, exitCode and a truncation flag for each stream, or an error code if the command cannot return output. A nonzero exitCode indicates failure or cancellation. Output may be truncated.",
      effect: "write",
      label: "Run a command on your Computer",
      requires: ["computer.execute"],
      input: shedRunCommandInputSchema,
      output: commandReply,
      handler: async (input, context, caller) => {
        const computer = context.env.COMPUTER;
        if (caller.computerId === null)
          return refusal.parse({ error: "not_granted" });
        const { exec } = computer;
        return runShedCommand(input, { exec });
      },
    }),
  },
});
