import * as z from "zod";
import { processListOutputSchema } from "@fungi.computer/computer-contract";
import { runObservationSchema } from "@fungi.computer/agar/run-observation";
import { observeProcess, type ShedProcessRecord } from "./observation.js";

const process = processListOutputSchema.shape.processes.element;
const processCursorSchema = z.strictObject({
  computerId: z.string().min(1).max(256),
  startedAt: process.shape.startedAt,
  id: process.shape.id,
});
export const processPageInputSchema = z.strictObject({
  limit: z.number().int().min(1).max(64).default(64),
  after: processCursorSchema.optional(),
});
const inventoryProcess = process.extend({ command: z.string().max(16384) });
/** What the Computer reports, before Shed marks what this caller may control. */
export const processInventorySchema = processListOutputSchema.extend({
  processes: z.array(inventoryProcess).max(64),
});
export const processPageSchema = processListOutputSchema.extend({
  processes: z
    .array(
      inventoryProcess.extend({
        /** Whether this caller started the process, so `stop` and `restart` accept it. */
        controllable: z.boolean(),
        /** The same process as a run; read its log through `observe`. */
        run: runObservationSchema,
      }),
    )
    .max(64),
  next: processCursorSchema.optional(),
});

/** Keyset pages preserve the Computer inventory's newest-first ordering. */
export function pageProcesses(
  inventory: z.output<typeof processInventorySchema>,
  input: z.output<typeof processPageInputSchema>,
  computerId: string,
  controlled: ReadonlyMap<string, ShedProcessRecord>,
): z.output<typeof processPageSchema> {
  const after = input.after;
  const remaining =
    after === undefined
      ? inventory.processes
      : inventory.processes.filter(
          (item) =>
            item.startedAt < after.startedAt ||
            (item.startedAt === after.startedAt && item.id < after.id),
        );
  const processes = remaining.slice(0, input.limit).map((item) => {
    const record = controlled.get(item.id) ?? null;
    return {
      ...item,
      controllable: record !== null,
      run: observeProcess(item, record, null),
    };
  });
  const last = processes.at(-1);
  return remaining.length > input.limit && last !== undefined
    ? {
        processes,
        next: { computerId, startedAt: last.startedAt, id: last.id },
      }
    : { processes };
}
