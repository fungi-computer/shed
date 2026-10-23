import * as z from "zod";
import { processListOutputSchema } from "@fungi.computer/computer-contract";

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
export const processPageSchema = processListOutputSchema.extend({
  processes: z
    .array(process.extend({ command: z.string().max(16384) }))
    .max(64),
  next: processCursorSchema.optional(),
});

/** Keyset pages preserve the Computer inventory's newest-first ordering. */
export function pageProcesses(
  inventory: z.output<typeof processPageSchema>,
  input: z.output<typeof processPageInputSchema>,
  computerId: string,
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
  const processes = remaining.slice(0, input.limit);
  const last = processes.at(-1);
  return remaining.length > input.limit && last !== undefined
    ? {
        processes,
        next: { computerId, startedAt: last.startedAt, id: last.id },
      }
    : { processes };
}
