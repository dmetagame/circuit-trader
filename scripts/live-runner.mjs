#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_STRATEGY,
  claudeSynthesizer,
  constitutionDigest,
  deterministicSynthesizer,
  initState,
  parseConstitution,
  parseRuntimeState,
  runTick,
  verifyConstitution,
} from "circuit-trader-policy";
import { createCmcMarketSource, createTrustWalletWallet } from "@circuit-trader/connectors";
import { acquireRunnerLock, appendJsonlDurable, ExecutionJournal, writeJsonAtomic } from "./durable-execution.mjs";

const args = parseArgs(process.argv.slice(2));
await loadEnvFile(args.envFile ?? process.env.ENV_FILE ?? ".env.worker.local");

const statePath = resolve(process.env.RUNNER_STATE_PATH ?? ".circuit-trader/state.json");
const timelinePath = resolve(process.env.RUNNER_TIMELINE_PATH ?? ".circuit-trader/timeline.jsonl");
const journalPath = resolve(process.env.RUNNER_JOURNAL_PATH ?? ".circuit-trader/execution-journal.json");
const lockPath = resolve(process.env.RUNNER_LOCK_PATH ?? ".circuit-trader/runner.lock");
const intervalMs = Number(args.intervalMs ?? process.env.RUNNER_INTERVAL_MS ?? 15 * 60 * 1000);
const reserveAsset = process.env.AGENT_RESERVE_ASSET ?? "USDT";
const assets = csv(process.env.AGENT_ASSETS ?? "BNB,TWT").filter((a) => a !== reserveAsset);
const tokenAddresses = parseJsonMap(process.env.AGENT_TOKEN_ADDRESSES);
const baseTradeUsd = finiteNumberEnv("AGENT_BASE_TRADE_USD", 4, { minExclusive: 0 });
const minStrengthToTrade = finiteNumberEnv("AGENT_MIN_STRENGTH", 0.3, { min: 0, max: 1 });
const requireSigned = boolEnv("REQUIRE_SIGNED_CONSTITUTION", true);
const requireSignerIsWallet = boolEnv("REQUIRE_CONSTITUTION_SIGNER_IS_WALLET", true);
const synthesizer = selectSynthesizer();

if (!assets.length) throw new Error("AGENT_ASSETS must include at least one non-reserve asset");
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("RUNNER_INTERVAL_MS must be a positive number");

await ensureDir(statePath);
await ensureDir(timelinePath);
await ensureDir(journalPath);

if (args.check) {
  await runCheck();
} else {
  const releaseLock = await acquireRunnerLock(lockPath);
  try {
    if (args.once) {
      await runOnce();
    } else {
      console.log(`Circuit Trader live runner started. intervalMs=${intervalMs} assets=${assets.join(",")}`);
      for (;;) {
        const started = Date.now();
        try {
          await runOnce();
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          console.error(`[${new Date().toISOString()}] tick failed: ${error}`);
          await appendJsonl(timelinePath, { kind: "runner-error", now: new Date().toISOString(), error });
        }
        const elapsed = Date.now() - started;
        await sleep(Math.max(1000, intervalMs - elapsed));
      }
    }
  } finally {
    await releaseLock();
  }
}

async function runCheck() {
  const constitution = await loadConstitution();
  let cmc = null;
  let twak = null;
  try {
    const cmcConn = createCmcMarketSource();
    const twakConn = createTrustWalletWallet({
      reserveAsset,
      chainId: constitution.chainId,
      tokenAddresses,
      ...(process.env.AGENT_WALLET_ADDRESS ? { address: process.env.AGENT_WALLET_ADDRESS } : {}),
    });
    cmc = cmcConn.transport;
    twak = twakConn.transport;

    // TWAK's stdio server handles wallet calls serially; keep preflight ordering explicit.
    console.error("preflight: checking wallet portfolio");
    const portfolio = await twakConn.wallet.getPortfolio();
    if (constitution.nativeAsset && constitution.portfolio.minNativeGasReserveUsd != null) {
      const nativeBalanceUsd = portfolio.positions[constitution.nativeAsset] ?? 0;
      if (nativeBalanceUsd < constitution.portfolio.minNativeGasReserveUsd) {
        throw new Error(
          `${constitution.nativeAsset} gas reserve ${nativeBalanceUsd} USD is below signed minimum ${constitution.portfolio.minNativeGasReserveUsd} USD`,
        );
      }
    }
    const checks = [];
    for (const asset of assets) {
      console.error(`preflight: checking ${asset} token risk`);
      const tokenRiskScore = await twakConn.wallet.getTokenRiskScore(asset);
      console.error(`preflight: checking ${asset} CMC market data`);
      const market = await cmcConn.source.getMarketData(asset);
      console.error(`preflight: checking ${asset} executable quote`);
      const quote = await twakConn.wallet.getQuote({ asset, side: "buy", sizeUsd: constitution.perTrade.minTradeUsd });
      checks.push({ asset, marketPriceUsd: market.priceUsd, tokenRiskScore, expectedSlippageBps: quote.expectedSlippageBps });
    }
    console.log(
      JSON.stringify({
        ok: true,
        agentId: constitution.agentId,
        walletAddress: constitution.walletAddress,
        equityUsd: portfolio.equityUsd,
        reserveUsd: portfolio.reserveUsd,
        checks,
      }),
    );
  } finally {
    await cmc?.close().catch(() => {});
    await twak?.close().catch(() => {});
  }
}

async function runOnce() {
  const now = new Date().toISOString();
  const constitution = await loadConstitution();
  let state = (await loadState(statePath)) ?? initState(0, now);
  const journal = new ExecutionJournal(journalPath, (nextState) => saveState(statePath, nextState));
  const recovery = await journal.recover(state);
  state = recovery.state;
  if (recovery.outcome !== "none") {
    await appendJsonl(timelinePath, { kind: "execution-recovery", now, outcome: recovery.outcome, executionId: recovery.executionId });
  }

  let cmc = null;
  let twak = null;
  try {
    const cmcConn = createCmcMarketSource();
    const twakConn = createTrustWalletWallet({
      reserveAsset,
      chainId: constitution.chainId,
      tokenAddresses,
      ...(process.env.AGENT_WALLET_ADDRESS ? { address: process.env.AGENT_WALLET_ADDRESS } : {}),
    });
    cmc = cmcConn.transport;
    twak = twakConn.transport;

    const tick = await runTick({
      constitution,
      state,
      wallet: twakConn.wallet,
      market: cmcConn.source,
      synthesizer,
      executionObserver: journal,
      config: {
        strategy: DEFAULT_STRATEGY,
        sizing: {
          baseTradeUsd,
          minStrengthToTrade,
        },
        assets,
      },
      now,
    });

    await saveState(statePath, tick.state);
    const summary = summarizeTick(tick);
    await appendJsonl(timelinePath, summary);
    console.log(JSON.stringify(summary));
    try {
      await publishLiveSnapshot(constitution, tick);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`live snapshot publish failed: ${message}`);
      await appendJsonl(timelinePath, { kind: "publish-error", now, error: message });
    }
  } catch (error) {
    const persistedState = (await loadState(statePath)) ?? state;
    const emergencyRecovery = await journal.recover(persistedState);
    if (emergencyRecovery.outcome !== "none") {
      await appendJsonl(timelinePath, {
        kind: "execution-recovery",
        now: new Date().toISOString(),
        outcome: emergencyRecovery.outcome,
        executionId: emergencyRecovery.executionId,
      });
    }
    throw error;
  } finally {
    await cmc?.close().catch(() => {});
    await twak?.close().catch(() => {});
  }
}

function selectSynthesizer() {
  const mode = (process.env.SYNTHESIZER_MODE ?? "deterministic").toLowerCase();
  if (mode === "deterministic" || mode === "free") return deterministicSynthesizer;
  if (mode === "claude") return claudeSynthesizer();
  throw new Error("SYNTHESIZER_MODE must be deterministic or claude");
}

async function loadConstitution() {
  const raw = process.env.CONSTITUTION_JSON
    ? JSON.parse(process.env.CONSTITUTION_JSON)
    : process.env.CONSTITUTION_PATH
      ? JSON.parse(await readFile(resolve(process.env.CONSTITUTION_PATH), "utf8"))
      : null;
  if (!raw) throw new Error("set CONSTITUTION_JSON or CONSTITUTION_PATH before running live");

  const constitution = parseConstitution(raw);
  if (constitution.reserveAsset !== reserveAsset) {
    throw new Error(`constitution reserve ${constitution.reserveAsset} does not match AGENT_RESERVE_ASSET ${reserveAsset}`);
  }
  const configuredWallet = process.env.AGENT_WALLET_ADDRESS;
  if (!configuredWallet) throw new Error("AGENT_WALLET_ADDRESS is required");
  if (configuredWallet.toLowerCase() !== constitution.walletAddress.toLowerCase()) {
    throw new Error("AGENT_WALLET_ADDRESS does not match the constitution wallet");
  }
  const disallowed = assets.filter((asset) => !constitution.allowedAssets.includes(asset));
  if (disallowed.length) throw new Error(`AGENT_ASSETS contains assets outside the constitution: ${disallowed.join(",")}`);
  if (requireSigned) {
    const verification = await verifyConstitution(constitution, { requireSignerIsWallet });
    if (!verification.valid) throw new Error(`constitution signature invalid: ${verification.reason ?? "unknown"}`);
  }
  return constitution;
}

async function loadState(file) {
  try {
    return parseRuntimeState(JSON.parse(await readFile(file, "utf8")));
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

async function saveState(file, state) {
  await writeJsonAtomic(file, state);
}

function summarizeTick(tick) {
  const highWaterMarkUsd = Math.max(tick.state.highWaterMarkUsd, tick.portfolioAfter.equityUsd);
  return {
    kind: "tick",
    now: tick.now,
    note: tick.note,
    killSwitch: tick.killSwitchEngaged,
    killSwitchReason: tick.state.killSwitchReason,
    equityUsd: tick.portfolioAfter.equityUsd,
    reserveUsd: tick.portfolioAfter.reserveUsd,
    highWaterMarkUsd,
    drawdownPct:
      highWaterMarkUsd > 0 ? ((highWaterMarkUsd - tick.portfolioAfter.equityUsd) / highWaterMarkUsd) * 100 : 0,
    tradesToday: tick.state.tradesToday,
    results: tick.results.map((r) => ({
      asset: r.asset,
      signal: r.signal.action,
      allowed: r.decision?.allowed ?? false,
      clamped: (r.decision?.adjustments.length ?? 0) > 0,
      txHash: r.fill?.txHash ?? null,
      filledUsd: r.fill?.filledUsd ?? null,
      denial: r.decision && !r.decision.allowed ? r.decision.violations[0]?.code ?? null : null,
      denialMessage: r.decision && !r.decision.allowed ? r.decision.violations[0]?.message ?? null : null,
      rationale: r.verdict?.rationale ?? null,
      audit: r.audit,
      error: r.error,
    })),
  };
}

async function publishLiveSnapshot(constitution, tick) {
  const baseUrl = process.env.LIVE_DASHBOARD_URL;
  const secret = process.env.LIVE_INGEST_SECRET;
  if (!baseUrl || !secret) return;

  const { views, count } = await loadTimelineViews(timelinePath);
  const highWaterMarkUsd = Math.max(tick.state.highWaterMarkUsd, tick.portfolioAfter.equityUsd);
  const envelope = {
    updatedAt: tick.now,
    snapshot: {
      constitution: {
        agentId: constitution.agentId,
        chainId: constitution.chainId,
        walletAddress: constitution.walletAddress,
        allowedAssets: constitution.allowedAssets,
        reserveAsset: constitution.reserveAsset,
        nativeAsset: constitution.nativeAsset,
        minNativeGasReserveUsd: constitution.portfolio.minNativeGasReserveUsd,
        maxTradeUsd: constitution.perTrade.maxTradeUsd,
        maxDrawdownPct: constitution.riskGates.maxDrawdownPct,
        minSignalConfidence: constitution.riskGates.minSignalConfidence,
        maxTokenRiskScore: constitution.riskGates.maxTokenRiskScore,
        digest: constitutionDigest(constitution),
        signer: constitution.signature?.signer ?? null,
        signature: constitution.signature?.value ?? null,
      },
      portfolio: tick.portfolioAfter,
      killSwitch: { engaged: tick.state.killSwitchEngaged, reason: tick.state.killSwitchReason },
      highWaterMarkUsd,
      initialEquityUsd: tick.state.initialEquityUsd,
      pnlUsd: tick.portfolioAfter.equityUsd - tick.state.initialEquityUsd,
      returnPct:
        tick.state.initialEquityUsd > 0
          ? ((tick.portfolioAfter.equityUsd - tick.state.initialEquityUsd) / tick.state.initialEquityUsd) * 100
          : 0,
      drawdownPct:
        highWaterMarkUsd > 0 ? ((highWaterMarkUsd - tick.portfolioAfter.equityUsd) / highWaterMarkUsd) * 100 : 0,
      tickCount: count,
      timeline: views,
    },
  };

  const endpoint = new URL("/api/live", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`dashboard returned HTTP ${response.status}`);
}

async function loadTimelineViews(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { views: [], count: 0 };
    }
    throw error;
  }

  const entries = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Preserve dashboard availability if a process died during an older append.
    }
  }
  const ticks = entries.filter((entry) => entry.kind === "tick");
  const views = ticks
    .slice(-50)
    .reverse()
    .map((entry, offset) => summaryToView(entry, ticks.length - offset));
  return { views, count: ticks.length };
}

function summaryToView(entry, index) {
  const results = Array.isArray(entry.results) ? entry.results : [];
  const assets =
    entry.killSwitch && results.length === 0
      ? [
          {
            asset: "-",
            status: "BREAKER",
            headline: entry.note,
            sizeUsd: null,
            txHash: null,
            reason: entry.killSwitchReason ?? entry.note,
            rationale: null,
            audit: [entry.note],
          },
        ]
      : results.map((result) => {
          const status = result.error
            ? "ERROR"
            : result.denial
              ? "DENIED"
              : result.signal === "hold"
                ? "HOLD"
                : result.allowed
                  ? result.clamped
                    ? "CLAMPED"
                    : "EXECUTED"
                  : "HOLD";
          const headline = result.error
            ? result.error
            : result.denial
              ? `${result.denial}: ${result.denialMessage ?? "denied"}`
              : result.signal === "hold"
                ? "Strategy held"
                : `${result.signal} ${result.filledUsd ?? 0} USD ${result.asset}`;
          return {
            asset: result.asset,
            status,
            headline,
            sizeUsd: result.filledUsd,
            txHash: result.txHash,
            reason: result.error ?? result.denialMessage ?? null,
            rationale: result.rationale ?? null,
            audit: Array.isArray(result.audit) ? result.audit : [],
          };
        });

  return {
    index,
    now: entry.now,
    note: entry.note,
    killSwitch: Boolean(entry.killSwitch),
    equityUsd: Number(entry.equityUsd ?? 0),
    reserveUsd: Number(entry.reserveUsd ?? 0),
    drawdownPct: Number(entry.drawdownPct ?? 0),
    assets,
  };
}

async function appendJsonl(file, value) {
  await appendJsonlDurable(file, value);
}

async function ensureDir(file) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
}

function csv(raw) {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function parseJsonMap(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AGENT_TOKEN_ADDRESSES must be a JSON object");
  }
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k.toUpperCase(), String(v)]));
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function finiteNumberEnv(name, fallback, bounds = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (bounds.min != null && value < bounds.min) throw new Error(`${name} must be >= ${bounds.min}`);
  if (bounds.minExclusive != null && value <= bounds.minExclusive) throw new Error(`${name} must be > ${bounds.minExclusive}`);
  if (bounds.max != null && value > bounds.max) throw new Error(`${name} must be <= ${bounds.max}`);
  return value;
}

async function loadEnvFile(file) {
  if (!file) return;
  let text;
  try {
    text = await readFile(resolve(file), "utf8");
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return;
    throw e;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (process.env[key] != null) continue;
    process.env[key] = stripQuotes(trimmed.slice(idx + 1).trim());
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseArgs(argv) {
  const out = { once: false, check: false, envFile: null, intervalMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") out.once = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--env-file") out.envFile = argv[++i] ?? null;
    else if (arg === "--interval-ms") out.intervalMs = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.once && out.check) throw new Error("--once and --check cannot be used together");
  return out;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
