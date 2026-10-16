import { processesGill } from "./gills.js";
import {
  processPageInputSchema,
  processPageSchema,
  pageProcesses,
} from "./process-page.js";
import * as z from "zod";
import { Base64 } from "effect/encoding";
import { computerPortInputSchema } from "@fungi.computer/computer/operations";
import {
  runShedCommand,
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
} from "@fungi.computer/computer/operations";
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
    COMPUTER?: Partial<ShedComputer> &
      Readonly<{
        ports?(input: Record<string, never>): Promise<WhistleJsonValue>;
        preview?(input: { port: number }): Promise<z.core.util.JSONType>;
        processKill?(
          input: z.output<typeof processIdInputSchema>,
        ): Promise<z.core.util.JSONType>;
        read?(input: {
          path: string;
          byteOffset: number;
          byteLength: number;
        }): Promise<z.core.util.JSONType>;
        exec?(input: z.output<typeof command>): Promise<WhistleJsonValue>;
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
        if (!caller.computerId || !context.env.COMPUTER?.preview)
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
        if (!caller.computerId || !context.env.COMPUTER?.read || !context.runs)
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
      requires: ["computer.execute", "computer.writeFile"],
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
        if (
          !caller.computerId ||
          !computer?.processStart ||
          !computer.processes ||
          !context.runs
        )
          throw new Error("Computer access is not granted");
        if (!caller.idempotencyKey)
          throw new Error(
            "A host idempotency key is required to start a process",
          );
        const { processStart, processes, workflowGitPass, write } = computer;
        return context.runs.start(
          input,
          caller.computerId,
          caller.idempotencyKey,
          caller.actor,
          {
            processStart,
            processes,
            workflowGitPass,
            write,
          },
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
        if (!caller.computerId || !context.env.COMPUTER?.processKill)
          throw new Error("Computer access is not granted");
        if (!context.runs?.owns(input.id, caller.computerId, caller.actor))
          return refusal.parse({ error: "not_found" });
        return z
          .union([processKillOutputSchema, refusal])
          .parse(await context.env.COMPUTER.processKill(input));
      },
    }),
    run: defineAppMethod({
      description:
        "Run one command on the pinned Computer, retaining a log and polling until it exits.",
      effect: "write",
      requires: ["computer.execute", "computer.writeFile"],
      pending: true,
      input: shedRunInputSchema,
      output: z.union([
        z.strictObject({
          exitCode: z.number().int(),
          logPath: z.string(),
        }),
        refusal,
      ]),
      handler: (input, context: ShedMethodContext, caller) => {
        const computer = context.env.COMPUTER;
        if (
          !caller.computerId ||
          !computer?.processStart ||
          !computer.processes ||
          !context.runs
        )
          throw new Error("Computer access is not granted");
        const { processStart, processes, workflowGitPass, write } = computer;
        if (!caller.idempotencyKey)
          throw new Error("A host idempotency key is required to start a run");
        return context.runs.run(
          input,
          caller.computerId,
          caller.idempotencyKey,
          caller.actor,
          { processStart, processes, workflowGitPass, write },
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
        caller.computerId === null || !context.env.COMPUTER?.ports
          ? refusal.parse({ error: "not_granted" })
          : portsReply.parse(await context.env.COMPUTER.ports(input)),
    }),
    listProcesses: defineAppMethod({
      description:
        "List up to 64 retained processes on the attached Computer. This read-only inventory requires computer.execute and starts nothing.",
      effect: "read",
      requires: ["computer.execute"],
      input: processPageInputSchema,
      output: processesReply,
      handler: async (input, context, caller) => {
        if (caller.computerId === null || !context.env.COMPUTER?.processes)
          return refusal.parse({ error: "not_granted" });
        if (
          input.after !== undefined &&
          input.after.computerId !== caller.computerId
        )
          return refusal.parse({ error: "invalid" });
        const inventory = processesReply.parse(
          await context.env.COMPUTER.processes({}),
        );
        return "error" in inventory
          ? inventory
          : pageProcesses(inventory, input, caller.computerId);
      },
    }),
    runCommand: defineAppMethod({
      description:
        "Execute a shell command on the attached Computer, with an optional absolute cwd and a timeout up to 45 seconds. A Workflow step's admitted gitAccess reaches the command as $FUNGI_GIT_REMOTE with command-local Git credentials. The host mints request identity, owns the per-attachment execution budget and attribution. Each output stream is bounded to the Computer’s 64 KiB byte slice, with up to two extra UTF-8 bytes from a replacement character, and may be truncated.",
      effect: "write",
      requires: ["computer.execute", "computer.writeFile"],
      input: shedRunCommandInputSchema,
      output: commandReply,
      handler: async (input, context, caller) => {
        const computer = context.env.COMPUTER;
        if (caller.computerId === null || !computer?.exec)
          return refusal.parse({ error: "not_granted" });
        const { exec, workflowGitPass, write } = computer;
        return runShedCommand(input, { exec, workflowGitPass, write });
      },
    }),
  },
});
