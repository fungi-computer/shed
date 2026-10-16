import * as z from "zod";
import { Hex } from "effect/encoding";
import type { HostActor } from "@fungi.computer/puffball/app-method-runtime";
import {
  workflowGitPassResultSchema,
  type WorkflowGitPassResult,
} from "@fungi.computer/agar/computer-contracts";
import { resolvedGitAccessSchema } from "@fungi.computer/braid/git-access";
import { pending } from "@fungi.computer/agar/backend-definition";
import type { WhistleJsonValue } from "@fungi.computer/whistle";
import { AppMethodRefusal } from "@fungi.computer/agar/backend";
import {
  computerProcessSchema,
  maximumProcessRecords,
  writeOutputSchema,
  type ComputerFileWriteInput,
  processStartInputSchema,
  processListOutputSchema,
  type ComputerProcess,
} from "@fungi.computer/computer/operations";
import {
  runCommandInputSchema,
  runCommandResultSchema,
  shedComputerRefusalSchema,
} from "../src/light-shell/run-command-contract.js";

/** What a Git command needs from a pass: its remote and any header credential. */
type GitCredential = Pick<WorkflowGitPassResult, "remote" | "bearer">;
const processInputSchema = processStartInputSchema.omit({
  requestId: true,
  requestScope: true,
});
export const shedRunInputSchema = processInputSchema
  .omit({ port: true })
  .extend({
    gitAccess: resolvedGitAccessSchema.optional(),
  });
export const shedStartInputSchema = processInputSchema.extend({
  gitAccess: resolvedGitAccessSchema.optional(),
});
export type ShedStartInput = z.output<typeof shedStartInputSchema>;
export type ShedRunInput = z.output<typeof shedRunInputSchema>;

/** Facet-owned records associate one trusted logical call with one native process. */
export type ShedSql = {
  exec(
    query: string,
    ...values: (string | number | null)[]
  ): { toArray(): unknown[] };
};
export type ShedComputer = Readonly<{
  workflowGitPass?:
    | ((input: Record<string, never>) => Promise<z.core.util.JSONType>)
    | undefined;
  write?:
    | ((input: ComputerFileWriteInput) => Promise<z.core.util.JSONType>)
    | undefined;
  processStart(input: {
    command: string;
    cwd?: string | undefined;
    port?: number | undefined;
  }): Promise<z.core.util.JSONType>;
  processes(input: Record<string, never>): Promise<z.core.util.JSONType>;
}>;
const rowSchema = z.strictObject({
  requestKey: z.string(),
  computerId: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  processId: z.string().nullable(),
  phase: z.enum(["starting", "running", "exited"]),
  startedAt: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  logPath: z.string(),
  gitAccess: z.string().nullable(),
  passId: z.string().nullable(),
  remote: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
});
// A header-admitted pass reaches git only as command-local
// http.<remote>.extraHeader config, read from a one-shot file the command
// deletes; neither the command nor any repository config ever holds it.
function gitCredentialFile(pass: GitCredential) {
  return pass.bearer === undefined
    ? `${pass.remote}\n`
    : `${pass.remote}\n${pass.bearer}\n`;
}
function gitCredentialCommand(
  remotePath: string,
  pass: GitCredential,
  command: string,
) {
  const read = `{ IFS= read -r _fungi_git_remote && IFS= read -r _fungi_git_bearer; } < ${quote(remotePath)}; rm -f -- ${quote(remotePath)}; test -n "$_fungi_git_remote"`;
  return pass.bearer === undefined
    ? `${read} && FUNGI_GIT_REMOTE="$_fungi_git_remote" bash -c ${quote(command)}`
    : `${read} && test -n "$_fungi_git_bearer" && FUNGI_GIT_REMOTE="$_fungi_git_remote" GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$_fungi_git_remote.extraHeader" GIT_CONFIG_VALUE_0="Authorization: Bearer $_fungi_git_bearer" bash -c ${quote(command)}`;
}

export const shedRunCommandInputSchema = runCommandInputSchema.extend({
  gitAccess: resolvedGitAccessSchema.optional(),
});
export type ShedRunCommandInput = z.output<typeof shedRunCommandInputSchema>;
export type ShedRunCommandResult = z.output<typeof runCommandResultSchema>;

/**
 * One bounded exec that presents the step's Workflow Git pass exactly as
 * `run` does: `$FUNGI_GIT_REMOTE` plus command-local header config. Without
 * `gitAccess` it is the plain exec.
 */
export async function runShedCommand(
  input: ShedRunCommandInput,
  computer: Readonly<{
    exec(
      input: Omit<ShedRunCommandInput, "gitAccess">,
    ): Promise<WhistleJsonValue>;
    workflowGitPass?: ShedComputer["workflowGitPass"];
    write?: ShedComputer["write"];
  }>,
  now: () => number = Date.now,
): Promise<ShedRunCommandResult> {
  const { gitAccess, ...exec } = input;
  if (gitAccess === undefined)
    return runCommandResultSchema.parse(await computer.exec(exec));
  if (!computer.workflowGitPass || !computer.write)
    return shedComputerRefusalSchema.parse({ error: "not_granted" });
  const minted = z
    .union([workflowGitPassResultSchema, shedComputerRefusalSchema])
    .parse(await computer.workflowGitPass({}));
  if ("error" in minted) return minted;
  if (minted.expiresAt <= now() + 5000)
    throw new Error("Workflow Git pass expires before the command starts");
  const remotePath = `/workspace/.fungi-git-${Hex.encode(crypto.getRandomValues(new Uint8Array(16)))}.remote`;
  const content = gitCredentialFile(minted);
  const written = await computer.write({ path: remotePath, content });
  const refused = shedComputerRefusalSchema.safeParse(written);
  if (refused.success) return refused.data;
  const reply = writeOutputSchema.parse(written);
  if (
    reply.path !== remotePath ||
    reply.bytes !== new TextEncoder().encode(content).byteLength
  )
    throw new Error("Invalid Computer credential file reply");
  return runCommandResultSchema.parse(
    await computer.exec({
      ...exec,
      command: gitCredentialCommand(remotePath, minted, exec.command),
    }),
  );
}

function claimKey(actor: HostActor, method: "start" | "run", key: string) {
  return JSON.stringify([actor, method, key]);
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// A command that ran to completion is a normal result at any exit code,
// zero or not: the caller (a Workflow step, for example) tells "the command
// failed" from "the platform failed" only if a non-zero exit comes back as
// a value, never as a thrown dispatch failure. Only a genuinely missing
// exit status -- the Computer's own record of this process was replaced or
// expired before it observed the exit -- is a platform-level failure to
// report completion at all, and stays an exception.
function completion(exitCode: number | null, logPath: string) {
  if (exitCode === null)
    throw new Error(`Process exit status is unavailable. Log: ${logPath}`);
  return { exitCode, logPath };
}

/** The Computer owns execution and exit state; Shed only remembers the call-to-process link. */
export function createShedRuns(sql: ShedSql, now: () => number = Date.now) {
  // Unscoped records are not current claims; do not read or import the old ledger.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS shed_process_claims (requestKey TEXT PRIMARY KEY, computerId TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT, processId TEXT, phase TEXT NOT NULL, startedAt INTEGER, exitCode INTEGER, logPath TEXT NOT NULL, gitAccess TEXT, passId TEXT, remote TEXT, expiresAt INTEGER)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS shed_retired_claim_keys (requestKey TEXT PRIMARY KEY)",
  );
  sql.exec(
    "DELETE FROM shed_process_claims WHERE requestKey IN (SELECT requestKey FROM shed_retired_claim_keys)",
  );
  const starting = new Map<string, number | null>();
  function retired(requestKey: string) {
    return (
      sql
        .exec(
          "SELECT requestKey FROM shed_retired_claim_keys WHERE requestKey=?",
          requestKey,
        )
        .toArray().length !== 0
    );
  }
  function scopeRows(
    actor: HostActor,
    mode: "start" | "run",
    computerId: string,
  ) {
    return z
      .array(rowSchema)
      .parse(
        sql
          .exec(
            "SELECT * FROM shed_process_claims WHERE computerId=? AND json_extract(requestKey,'$[0]')=? AND json_extract(requestKey,'$[1]')=? ORDER BY startedAt ASC, processId ASC, rowid ASC",
            computerId,
            JSON.stringify(actor),
            mode,
          )
          .toArray(),
      );
  }
  function retire(requestKey: string, actor: HostActor, mode: "start" | "run") {
    // Record rejection first, so an interruption cannot turn a retired key into a new start.
    sql.exec(
      "INSERT OR IGNORE INTO shed_retired_claim_keys (requestKey) VALUES (?)",
      requestKey,
    );
    sql.exec("DELETE FROM shed_process_claims WHERE requestKey=?", requestKey);
    // Replay refusal covers the latest 64 retired calls per member/method.
    // Older opaque keys are outside the retained replay horizon, like native history.
    sql.exec(
      "DELETE FROM shed_retired_claim_keys WHERE rowid IN (SELECT rowid FROM shed_retired_claim_keys WHERE json_extract(requestKey,'$[0]')=? AND json_extract(requestKey,'$[1]')=? ORDER BY rowid DESC LIMIT -1 OFFSET ?)",
      JSON.stringify(actor),
      mode,
      maximumProcessRecords,
    );
  }
  function trimScope(
    actor: HostActor,
    mode: "start" | "run",
    computerId: string,
    current: string,
  ) {
    const rows = scopeRows(actor, mode, computerId);
    let remaining = rows.length;
    for (const row of rows) {
      if (remaining <= maximumProcessRecords) break;
      if (
        row.requestKey === current ||
        row.phase === "running" ||
        starting.has(row.requestKey)
      )
        continue;
      retire(row.requestKey, actor, mode);
      remaining--;
    }
  }
  async function refreshScope(
    actor: HostActor,
    mode: "start" | "run",
    computerId: string,
    computer: ShedComputer,
  ) {
    const rows = scopeRows(actor, mode, computerId);
    if (rows.length < maximumProcessRecords) return null;
    const reply = await computer.processes({});
    const refused = shedComputerRefusalSchema.safeParse(reply);
    if (refused.success) return refused.data;
    const inventory = processListOutputSchema.parse(reply);
    for (const row of rows) {
      if (row.processId === null || starting.has(row.requestKey)) continue;
      const process = inventory.processes.find(
        (item) => item.id === row.processId,
      );
      if (process) observe(row.requestKey, process, row.logPath);
    }
    return null;
  }
  function read(requestKey: string) {
    if (retired(requestKey)) return null;
    const row = sql
      .exec("SELECT * FROM shed_process_claims WHERE requestKey=?", requestKey)
      .toArray()[0];
    return row === undefined ? null : rowSchema.parse(row);
  }
  function observe(
    requestKey: string,
    process: ComputerProcess,
    logPath: string,
  ) {
    sql.exec(
      "UPDATE shed_process_claims SET processId=?,phase=?,exitCode=?,startedAt=? WHERE requestKey=?",
      process.id,
      process.state === "exited" ? "exited" : "running",
      process.exitCode,
      process.startedAt,
      requestKey,
    );
    return process.port === null
      ? { process, logPath }
      : { process, logPath, port: process.port };
  }
  function verify(
    prior: z.output<typeof rowSchema>,
    input: ShedRunInput,
    computerId: string,
  ) {
    if (
      prior.computerId !== computerId ||
      prior.command !== input.command ||
      prior.cwd !== (input.cwd ?? null) ||
      prior.gitAccess !==
        (input.gitAccess === undefined ? null : JSON.stringify(input.gitAccess))
    )
      throw new AppMethodRefusal(
        "conflict",
        "Run identity conflicts with its original command, Git scope or Computer",
      );
  }
  async function claim(
    input: ShedStartInput,
    computerId: string,
    rawKey: string,
    actor: HostActor,
    computer: ShedComputer,
    mode: "start" | "run",
  ) {
    if (actor.kind !== "member")
      return shedComputerRefusalSchema.parse({ error: "not_granted" });
    const requestKey = claimKey(actor, mode, rawKey);
    if (retired(requestKey))
      return shedComputerRefusalSchema.parse({ error: "not_found" });
    const unavailable = await refreshScope(actor, mode, computerId, computer);
    if (unavailable !== null) return unavailable;
    if (retired(requestKey))
      return shedComputerRefusalSchema.parse({ error: "not_found" });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(requestKey),
    );
    const directory = `/workspace/.fungi/runs/call-${Hex.encode(new Uint8Array(digest))}`;
    const remotePath = `/workspace/.fungi-git-${Hex.encode(new Uint8Array(digest))}.remote`;
    const credentialFile = gitCredentialFile;
    function prepare(pass: GitCredential | null) {
      const logPath = `${directory}/out.log`;
      const command =
        pass === null
          ? `bash -c ${quote(input.command)}`
          : gitCredentialCommand(remotePath, pass, input.command);
      const script = `mkdir -p ${quote(directory)} && ${command} 2>&1 | tee ${quote(logPath)}`;
      const processInput: z.input<typeof processInputSchema> = {
        command: `bash -o pipefail -c ${quote(script)}`,
      };
      if (input.cwd !== undefined) processInput.cwd = input.cwd;
      if (input.port !== undefined) processInput.port = input.port;
      return { start: processInputSchema.parse(processInput), logPath };
    }
    async function dispatch(
      start: z.output<typeof processInputSchema>,
      logPath: string,
      pass: GitCredential | null,
      expiresAt: number | null,
    ) {
      const remote = pass?.remote ?? null;
      starting.set(requestKey, input.port ?? null);
      try {
        function checkLease() {
          if (remote !== null && (expiresAt === null || expiresAt <= now()))
            throw new Error(
              `Workflow Git pass expired before process dispatch. Log: ${logPath}`,
            );
        }
        checkLease();
        if (pass !== null) {
          if (!computer.write)
            throw new Error("Computer credential file access is unavailable");
          const content = credentialFile(pass);
          const reply = await computer.write({
            path: remotePath,
            content,
          });
          const refused = shedComputerRefusalSchema.safeParse(reply);
          if (refused.success) {
            sql.exec(
              "DELETE FROM shed_process_claims WHERE requestKey=?",
              requestKey,
            );
            return refused.data;
          }
          const written = writeOutputSchema.parse(reply);
          if (
            written.path !== remotePath ||
            written.bytes !== new TextEncoder().encode(content).byteLength
          )
            throw new Error("Invalid Computer credential file reply");
        }
        checkLease();
        const reply = await computer.processStart(start);
        const refused = shedComputerRefusalSchema.safeParse(reply);
        if (refused.success) {
          sql.exec(
            "DELETE FROM shed_process_claims WHERE requestKey=?",
            requestKey,
          );
          return refused.data;
        }
        const process = computerProcessSchema.parse(reply);
        if (process.port !== (input.port ?? null))
          throw new Error("Run identity conflicts with its declared port");
        return observe(requestKey, process, logPath);
      } finally {
        starting.delete(requestKey);
        trimScope(actor, mode, computerId, requestKey);
      }
    }
    const gitAccess =
      input.gitAccess === undefined ? null : JSON.stringify(input.gitAccess);
    async function mint() {
      if (!computer.workflowGitPass)
        throw new Error("Workflow Git pass binding is unavailable");
      const pass = workflowGitPassResultSchema.parse(
        await computer.workflowGitPass({}),
      );
      if (pass.expiresAt <= now() + 5000)
        throw new Error("Workflow Git pass expires before the next poll");
      return pass;
    }
    async function resume(prior: z.output<typeof rowSchema>) {
      verify(prior, input, computerId);
      if (prior.phase === "starting") {
        const activePort = starting.get(requestKey);
        if (activePort !== undefined) {
          if (activePort !== (input.port ?? null))
            throw new AppMethodRefusal(
              "conflict",
              "Run identity conflicts with its declared port",
            );
          return pending(5000);
        }
        // The host binding retains this call's native idempotency key across retries.
        if (mode === "start") {
          // Renew the same selector rather than storing a header credential.
          let pass: GitCredential | null = null;
          if (prior.remote !== null) {
            if (prior.expiresAt === null || prior.expiresAt <= now())
              throw new Error(
                `Workflow Git pass expired before process dispatch. Log: ${prior.logPath}`,
              );
            const renewed = await mint();
            if (
              renewed.passId !== prior.passId ||
              renewed.remote !== prior.remote
            )
              throw new Error(
                `Workflow Git renewal changed its original selector. Log: ${prior.logPath}`,
              );
            pass = renewed;
          }
          const prepared = prepare(pass);
          return dispatch(prepared.start, prior.logPath, pass, prior.expiresAt);
        }
        throw new Error(
          `Process start outcome is unavailable. Log: ${prior.logPath}`,
        );
      }
      const { processes } = processListOutputSchema.parse(
        await computer.processes({}),
      );
      const process = processes.find((item) => item.id === prior.processId);
      if (!process)
        throw new Error(
          `Process is no longer in the Computer inventory. Log: ${prior.logPath}`,
        );
      if (process.port !== (input.port ?? null))
        throw new AppMethodRefusal(
          "conflict",
          "Run identity conflicts with its declared port",
        );
      if (mode === "run" && process.state !== "exited" && gitAccess !== null) {
        if (prior.expiresAt === null || prior.expiresAt <= now())
          throw new Error(`Workflow Git pass expired. Log: ${prior.logPath}`);
        const pass = await mint();
        if (
          prior.expiresAt <= now() ||
          pass.passId !== prior.passId ||
          pass.remote !== prior.remote ||
          pass.expiresAt < prior.expiresAt
        )
          throw new Error(
            `Workflow Git renewal changed or expired its original selector. Log: ${prior.logPath}`,
          );
        sql.exec(
          "UPDATE shed_process_claims SET expiresAt=MAX(expiresAt,?) WHERE requestKey=?",
          pass.expiresAt,
          requestKey,
        );
      }
      return observe(requestKey, process, prior.logPath);
    }
    const prior = read(requestKey);
    if (prior) return resume(prior);
    // Mint can yield; recheck the durable claim before starting a process.
    const pass: WorkflowGitPassResult | null =
      gitAccess === null ? null : await mint();
    const claimed = read(requestKey);
    if (claimed) return resume(claimed);
    const { start, logPath } = prepare(pass);
    sql.exec(
      "INSERT INTO shed_process_claims (requestKey,computerId,command,cwd,phase,logPath,gitAccess,passId,remote,expiresAt) VALUES (?,?,?,?,'starting',?,?,?,?,?)",
      requestKey,
      computerId,
      input.command,
      input.cwd ?? null,
      logPath,
      gitAccess,
      pass?.passId ?? null,
      pass?.remote ?? null,
      pass?.expiresAt ?? null,
    );
    return dispatch(start, logPath, pass, pass?.expiresAt ?? null);
  }
  return {
    owns(processId: string, computerId: string, actor: HostActor) {
      if (actor.kind !== "member") return false;
      return (
        sql
          .exec(
            "SELECT requestKey FROM shed_process_claims WHERE processId=? AND computerId=? AND json_extract(requestKey,'$[0]')=?",
            processId,
            computerId,
            JSON.stringify(actor),
          )
          .toArray().length !== 0
      );
    },
    logPath(
      rawKey: string,
      computerId: string,
      actor: HostActor,
    ): { path: string } | { error: "not_found" | "ambiguous" } {
      const rows = [
        read(claimKey(actor, "start", rawKey)),
        read(claimKey(actor, "run", rawKey)),
      ].filter((row) => row !== null && row.processId !== null);
      if (rows.length > 1) return { error: "ambiguous" };
      const row = rows[0];
      return row?.computerId === computerId
        ? { path: row.logPath }
        : { error: "not_found" };
    },
    start(
      input: ShedStartInput,
      computerId: string,
      requestKey: string,
      actor: HostActor,
      computer: ShedComputer,
    ) {
      return claim(input, computerId, requestKey, actor, computer, "start");
    },
    async run(
      input: ShedRunInput,
      computerId: string,
      requestKey: string,
      actor: HostActor,
      computer: ShedComputer,
    ) {
      if (actor.kind !== "member")
        return shedComputerRefusalSchema.parse({ error: "not_granted" });
      if (retired(claimKey(actor, "run", requestKey)))
        return shedComputerRefusalSchema.parse({ error: "not_found" });
      const prior = read(claimKey(actor, "run", requestKey));
      if (prior) {
        verify(prior, input, computerId);
        if (prior.phase === "exited")
          return completion(prior.exitCode, prior.logPath);
      }
      const result = await claim(
        input,
        computerId,
        requestKey,
        actor,
        computer,
        "run",
      );
      if ("kind" in result) return result;
      if ("error" in result) return result;
      return result.process.state === "exited"
        ? completion(result.process.exitCode, result.logPath)
        : pending(5000);
    },
  };
}
export type ShedRuns = ReturnType<typeof createShedRuns>;
