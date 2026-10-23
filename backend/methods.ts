import { resultRows } from "@fungi.computer/agar/method-presentation";
import { processesGill } from "./gills.js";
import {
  processPageInputSchema,
  processPageSchema,
  pageProcesses,
} from "./process-page.js";
import * as z from "zod";
import { Base64 } from "effect/encoding";
import { computerPortInputSchema } from "@fungi.computer/computer-contract";
import {
  runShedCommand,
  computerCall,
  shedRunCommandInputSchema,
  shedRunInputSchema,
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
  expiresAt: z.number().int().positive(),
});
const bytes = z.strictObject({
  path: z.string(),
  byteOffset: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.literal("base64"),
  truncated: z.boolean(),
});
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

export const appBackend = defineAppBackend<ShedMethodContext>({
  gills: [processesGill],
  methods: {
    expose: defineAppMethod({
      description:
        "Get an admitted preview URL for a port already exposed on the pinned Computer.",
      effect: "write",
      requires: ["computer.execute"],
      input: computerPortInputSchema,
      output: preview,
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId)
          throw new Error("Computer preview access is not granted");
        // Project the issued URL; preview-row presentation policy stays with the host.
        return z
          .object(preview.shape)
          .parse(await context.env.COMPUTER.preview(input));
      },
    }),
    logs: defineAppMethod({
      description:
        "Read up to 128 KiB from a run log, identified by its host call key; offsets and lengths are bytes.",
      effect: "read",
      requires: ["computer.readFile"],
      input: z.strictObject({
        run: z.string().min(1).max(128),
        offset: z.number().int().nonnegative().default(0),
        length: z.number().int().min(1).max(131072).default(131072),
      }),
      output: z.union([
        bytes.extend({ run: z.string() }),
        z.strictObject({ error: z.enum(["not_found", "ambiguous"]) }),
      ]),
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId || !context.runs)
          throw new Error("Computer file access is not granted");
        const log = context.runs.logPath(
          input.run,
          caller.computerId,
          caller.actor,
        );
        if ("error" in log) return log;
        const path = log.path;
        const reply = bytes.parse(
          await context.env.COMPUTER.read({
            path,
            byteOffset: input.offset,
            byteLength: input.length,
          }),
        );
        const decoded = Base64.decode(reply.content);
        if (
          reply.path !== path ||
          reply.byteOffset !== input.offset ||
          decoded._tag === "Failure" ||
          decoded.success.byteLength > input.length
        )
          throw new Error("Invalid Computer log reply");
        return { ...reply, run: input.run };
      },
    }),
    start: defineAppMethod({
      description:
        "Start one process on the pinned Computer and return its process and log path without waiting for exit.",
      effect: "write",
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
        if (!caller.idempotencyKey)
          throw new Error(
            "A host idempotency key is required to start a process",
          );
        const { processStart, processes } = computer;
        return context.runs.start(
          input,
          caller.computerId,
          caller.idempotencyKey,
          caller.actor,
          { processStart, processes },
        );
      },
    }),
    stop: defineAppMethod({
      description: "Signal a retained process on the pinned Computer to stop.",
      effect: "write",
      requires: ["computer.execute"],
      input: processIdInputSchema,
      output: z.union([processKillOutputSchema, refusal]),
      handler: async (input, context: ShedMethodContext, caller) => {
        if (!caller.computerId)
          throw new Error("Computer access is not granted");
        if (!context.runs?.owns(input.id, caller.computerId, caller.actor))
          return refusal.parse({ error: "not_found" });
        return z
          .union([processKillOutputSchema, refusal])
          .parse(
            await computerCall(() => context.env.COMPUTER.processKill(input)),
          );
      },
    }),
    run: defineAppMethod({
      description:
        "Run one command on the pinned Computer, retaining a log and polling until it exits.",
      effect: "write",
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
                detail: output.error,
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
        if (!caller.idempotencyKey)
          throw new Error("A host idempotency key is required to start a run");
        return context.runs.run(
          input,
          caller.computerId,
          caller.idempotencyKey,
          caller.actor,
          { processStart, processes },
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
        const inventory = processesReply.parse(
          await computerCall(() => context.env.COMPUTER.processes({})),
        );
        return "error" in inventory
          ? inventory
          : pageProcesses(inventory, input, caller.computerId);
      },
    }),
    runCommand: defineAppMethod({
      description:
        "Run a shell command on the attached Computer. Use cwd to choose an absolute working directory. The timeout is at most 45 seconds. In a Workflow Git step, use $FUNGI_GIT_REMOTE for the repository. Returns stdout, stderr, exitCode and a truncation flag for each stream, or an error code if the command cannot return output. A nonzero exitCode indicates failure or cancellation. Output may be truncated.",
      effect: "write",
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
