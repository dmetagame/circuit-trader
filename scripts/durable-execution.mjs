import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { engageKillSwitch, recordExecution } from "circuit-trader-policy";

export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  await syncDirectory(dirname(file));
}

export async function appendJsonlDurable(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ExecutionJournal {
  constructor(file, saveState) {
    this.file = file;
    this.saveState = saveState;
  }

  async beforeExecution(intent) {
    const existing = await readJsonIfPresent(this.file);
    if (existing) throw new Error(`unresolved execution journal already exists at ${this.file}`);
    await writeJsonAtomic(this.file, {
      schemaVersion: 1,
      status: "pending",
      createdAt: new Date().toISOString(),
      intent,
    });
  }

  async afterExecution(intent, fill, state) {
    const existing = parseJournal(await readJsonIfPresent(this.file));
    if (!existing || existing.intent.executionId !== intent.executionId) {
      throw new Error("execution journal does not match settled fill");
    }
    await writeJsonAtomic(this.file, { ...existing, status: "filled", fill });
    await this.saveState(state);
    await rm(this.file);
    await syncDirectory(dirname(this.file));
  }

  async afterRejection(intent) {
    const existing = parseJournal(await readJsonIfPresent(this.file));
    if (!existing || existing.status !== "pending" || existing.intent.executionId !== intent.executionId) {
      throw new Error("execution journal does not match rejected intent");
    }
    await rm(this.file);
    await syncDirectory(dirname(this.file));
  }

  async recover(state) {
    const entry = parseJournal(await readJsonIfPresent(this.file));
    if (!entry) return { state, outcome: "none" };

    if (entry.status === "pending") {
      const reason = `ambiguous execution ${entry.intent.executionId}: transaction outcome must be reconciled before trading`;
      const halted = engageKillSwitch(state, reason);
      await this.saveState(halted);
      return { state: halted, outcome: "ambiguous", executionId: entry.intent.executionId };
    }

    let recovered = state;
    if (!state.recordedExecutionIds.includes(entry.intent.executionId)) {
      recovered = recordExecution(
        state,
        entry.intent.order,
        entry.fill.filledUsd,
        entry.fill.executedAt,
        entry.intent.executionId,
      );
      await this.saveState(recovered);
    }
    await rm(this.file);
    await syncDirectory(dirname(this.file));
    return { state: recovered, outcome: "recovered", executionId: entry.intent.executionId };
  }
}

export async function acquireRunnerLock(lockDir) {
  const ownerFile = `${lockDir}/owner.json`;
  const token = `${process.pid}-${Date.now()}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeJsonAtomic(ownerFile, { pid: process.pid, token, startedAt: new Date().toISOString() });
      return async () => {
        const owner = await readJsonIfPresent(ownerFile);
        if (owner?.token === token) await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const owner = await readJsonIfPresent(ownerFile);
      if (owner && Number.isInteger(owner.pid) && processAlive(owner.pid)) {
        throw new Error(`another Circuit Trader runner is active (pid ${owner.pid})`);
      }
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  throw new Error(`could not acquire runner lock at ${lockDir}`);
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return null;
    throw error;
  }
}

function parseJournal(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw new Error("invalid execution journal");
  if (value.status !== "pending" && value.status !== "filled") throw new Error("invalid execution journal status");
  const intent = value.intent;
  if (!intent || typeof intent !== "object" || typeof intent.executionId !== "string" || !intent.order) {
    throw new Error("invalid execution journal intent");
  }
  if (value.status === "filled") {
    const fill = value.fill;
    if (!fill || typeof fill !== "object" || !Number.isFinite(fill.filledUsd) || typeof fill.executedAt !== "string") {
      throw new Error("invalid execution journal fill");
    }
  }
  return value;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

function isCode(error, code) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isCode(error, "EINVAL") && !isCode(error, "ENOTSUP")) throw error;
  } finally {
    await handle?.close();
  }
}
