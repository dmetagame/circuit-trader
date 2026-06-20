import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initState } from "circuit-trader-policy";
import { acquireRunnerLock, ExecutionJournal, writeJsonAtomic } from "./durable-execution.mjs";

const NOW = "2026-06-20T12:00:00.000Z";
const intent = {
  executionId: "dec_test",
  decisionId: "dec_test",
  evaluatedAt: NOW,
  order: { asset: "BNB", side: "buy", sizeUsd: 0.2, maxSlippageBps: 75 },
  portfolioBefore: { reserveUsd: 1, positions: {}, equityUsd: 1 },
};
const fill = {
  asset: "BNB",
  side: "buy",
  filledUsd: 0.2,
  price: 600,
  slippageBps: 20,
  txHash: `0x${"ab".repeat(32)}`,
  executedAt: NOW,
};

test("known fills are checkpointed and applied once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "circuit-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "execution.json");
  const stateFile = join(dir, "state.json");
  let saved;
  const journal = new ExecutionJournal(journalFile, async (state) => {
    saved = state;
    await writeJsonAtomic(stateFile, state);
  });

  await journal.beforeExecution(intent);
  const executed = { ...initState(1, NOW), reserveUsd: 0.8, positions: { BNB: 0.2 }, tradesToday: 1, recordedExecutionIds: [intent.executionId] };
  await journal.afterExecution(intent, fill, executed);

  assert.equal(saved.tradesToday, 1);
  assert.deepEqual(saved.recordedExecutionIds, [intent.executionId]);
  await assert.rejects(readFile(journalFile), { code: "ENOENT" });
});

test("a filled journal recovers counters idempotently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "circuit-recover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "execution.json");
  let saved;
  const journal = new ExecutionJournal(journalFile, async (state) => {
    saved = state;
  });
  await writeJsonAtomic(journalFile, { schemaVersion: 1, status: "filled", createdAt: NOW, intent, fill });

  const recovered = await journal.recover(initState(1, NOW));
  assert.equal(recovered.outcome, "recovered");
  assert.equal(saved.tradesToday, 1);
  assert.deepEqual(saved.recordedExecutionIds, [intent.executionId]);
});

test("an unknown transaction outcome engages the kill switch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "circuit-ambiguous-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "execution.json");
  let saved;
  const journal = new ExecutionJournal(journalFile, async (state) => {
    saved = state;
  });
  await journal.beforeExecution(intent);

  const recovered = await journal.recover(initState(1, NOW));
  assert.equal(recovered.outcome, "ambiguous");
  assert.equal(saved.killSwitchEngaged, true);
  assert.match(saved.killSwitchReason, /transaction outcome must be reconciled/);
});

test("a definitive wallet rejection clears its pending intent", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "circuit-rejected-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const journalFile = join(dir, "execution.json");
  const journal = new ExecutionJournal(journalFile, async () => {});
  await journal.beforeExecution(intent);
  await journal.afterRejection(intent);
  await assert.rejects(readFile(journalFile), { code: "ENOENT" });
});

test("runner lock excludes a second trader process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "circuit-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, "runner.lock");
  const release = await acquireRunnerLock(lock);
  await assert.rejects(acquireRunnerLock(lock), /another Circuit Trader runner is active/);
  await release();
  const releaseAgain = await acquireRunnerLock(lock);
  await releaseAgain();
});
