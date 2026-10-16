import * as z from "zod";
import { defineAppGill, type AppBackendGill } from "@fungi.computer/agar/gills";
import { relativeTime } from "@fungi.computer/gills/presentation";
import { processPageInputSchema, processPageSchema } from "./process-page.js";

const refused = z.object({ error: z.string() });
type GillRow = ReturnType<AppBackendGill["rows"]>["rows"][number];

/** Inventory only: this read never starts or stops a process. */
export const processesGill = defineAppGill({
  id: "processes",
  title: "Processes",
  source: "listProcesses",
  limit: 20,
  sizes: ["M", "L"],
  params: [
    { key: "computer", label: "Computer", kind: "computer", required: true },
  ],
  input: ({ limit, after }): ReturnType<AppBackendGill["input"]> => {
    const cursor: unknown = after === undefined ? undefined : JSON.parse(after);
    const input = processPageInputSchema.parse(
      cursor === undefined ? { limit } : { limit, after: cursor },
    );
    return input.after === undefined
      ? { limit: input.limit }
      : { limit: input.limit, after: input.after };
  },
  rows: (output) => {
    const identity = { viewId: "processes", title: "Processes" };
    const refusal = refused.safeParse(output);
    if (refusal.success)
      return refusal.data.error === "not_granted"
        ? {
            ...identity,
            state: "error",
            rows: [],
            error: "Choose a Computer and allow Shed to run commands.",
            recovery: { kind: "configure", param: "computer" },
          }
        : {
            ...identity,
            state: "error",
            rows: [],
            error:
              "The process inventory couldn't be read. Open Shed to check access and refresh.",
            recovery: { kind: "open" },
          };
    const page = processPageSchema.parse(output);
    if (page.processes.length === 0)
      return { ...identity, state: "empty", rows: [] };
    const rows = page.processes.map((process): GillRow => ({
      id: process.id,
      title: (process.command || "Process").slice(0, 4096),
      detail:
        `${process.cwd ?? "Unknown directory"} · ${relativeTime(process.startedAt)}${process.state === "exited" && process.exitCode !== null ? ` · Exit ${String(process.exitCode)}` : ""}`.slice(
          0,
          1024,
        ),
      status: {
        label: process.state,
        tone:
          process.state === "running"
            ? "success"
            : process.state === "uncertain"
              ? "warning"
              : "neutral",
      },
      open: { params: [{ key: "process", value: process.id }] },
    }));
    return page.next === undefined
      ? { ...identity, state: "full", rows }
      : { ...identity, state: "full", rows, next: JSON.stringify(page.next) };
  },
});
