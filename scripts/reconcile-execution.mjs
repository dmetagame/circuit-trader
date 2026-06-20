#!/usr/bin/env node
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseRuntimeState } from "circuit-trader-policy";
import { acquireRunnerLock, writeJsonAtomic } from "./durable-execution.mjs";

const args = parseArgs(process.argv.slice(2));
const statePath = resolve(args.state ?? ".circuit-trader/state.json");
const journalPath = resolve(args.journal ?? ".circuit-trader/execution-journal.json");
const lockPath = resolve(args.lock ?? ".circuit-trader/runner.lock");
const releaseLock = await acquireRunnerLock(lockPath);
try {
  const journal = JSON.parse(await readFile(journalPath, "utf8"));

  if (journal.status !== "pending" || journal.intent?.executionId !== args.executionId) {
    throw new Error("pending journal does not match --execution-id");
  }

  const fill = args.outcome === "filled" ? parseFill(args, journal) : null;
  let state = parseRuntimeState(JSON.parse(await readFile(statePath, "utf8")));
  const ambiguityReason = `ambiguous execution ${args.executionId}: transaction outcome must be reconciled before trading`;
  if (state.killSwitchReason === ambiguityReason) {
    state = { ...state, killSwitchEngaged: false, killSwitchReason: null };
    await writeJsonAtomic(statePath, state);
  }

  if (args.outcome === "rejected") {
    await rm(journalPath);
    console.log(JSON.stringify({ ok: true, executionId: args.executionId, outcome: "rejected", journalCleared: true }));
  } else {
    await writeJsonAtomic(journalPath, { ...journal, status: "filled", fill, reconciledAt: new Date().toISOString() });
    console.log(JSON.stringify({ ok: true, executionId: args.executionId, outcome: "filled", txHash: fill.txHash }));
  }
} finally {
  await releaseLock();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--outcome") out.outcome = argv[++i];
    else if (arg === "--execution-id") out.executionId = argv[++i];
    else if (arg === "--filled-usd") out.filledUsd = argv[++i];
    else if (arg === "--price") out.price = argv[++i];
    else if (arg === "--slippage-bps") out.slippageBps = argv[++i];
    else if (arg === "--tx-hash") out.txHash = argv[++i];
    else if (arg === "--executed-at") out.executedAt = argv[++i];
    else if (arg === "--state") out.state = argv[++i];
    else if (arg === "--journal") out.journal = argv[++i];
    else if (arg === "--lock") out.lock = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.outcome !== "rejected" && out.outcome !== "filled") throw new Error("--outcome must be rejected or filled");
  if (!out.executionId) throw new Error("--execution-id is required");
  return out;
}

function parseFill(values, journal) {
  return {
    asset: journal.intent.order.asset,
    side: journal.intent.order.side,
    filledUsd: positiveNumber(values.filledUsd, "--filled-usd"),
    price: positiveNumber(values.price, "--price"),
    slippageBps: nonnegativeNumber(values.slippageBps, "--slippage-bps"),
    txHash: validTxHash(values.txHash),
    executedAt: validDate(values.executedAt),
  };
}

function positiveNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function nonnegativeNumber(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
  return value;
}

function validTxHash(raw) {
  if (typeof raw !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(raw)) throw new Error("--tx-hash must be a 32-byte hex hash");
  return raw;
}

function validDate(raw) {
  if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) throw new Error("--executed-at must be an ISO timestamp");
  return raw;
}
