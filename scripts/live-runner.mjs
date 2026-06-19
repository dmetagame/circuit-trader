#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_STRATEGY,
  claudeSynthesizer,
  deterministicSynthesizer,
  initState,
  parseConstitution,
  runTick,
  verifyConstitution,
} from "circuit-trader-policy";
import { createCmcMarketSource, createTrustWalletWallet } from "@circuit-trader/connectors";

const args = parseArgs(process.argv.slice(2));
await loadEnvFile(args.envFile ?? process.env.ENV_FILE ?? ".env.local");

const statePath = resolve(process.env.RUNNER_STATE_PATH ?? ".circuit-trader/state.json");
const timelinePath = resolve(process.env.RUNNER_TIMELINE_PATH ?? ".circuit-trader/timeline.jsonl");
const intervalMs = Number(args.intervalMs ?? process.env.RUNNER_INTERVAL_MS ?? 15 * 60 * 1000);
const reserveAsset = process.env.AGENT_RESERVE_ASSET ?? "USDT";
const assets = csv(process.env.AGENT_ASSETS ?? "BNB,TWT,CAKE").filter((a) => a !== reserveAsset);
const tokenAddresses = parseJsonMap(process.env.AGENT_TOKEN_ADDRESSES);
const requireSigned = boolEnv("REQUIRE_SIGNED_CONSTITUTION", true);
const requireSignerIsWallet = boolEnv("REQUIRE_CONSTITUTION_SIGNER_IS_WALLET", true);
const synthesizer = selectSynthesizer();

if (!assets.length) throw new Error("AGENT_ASSETS must include at least one non-reserve asset");
if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error("RUNNER_INTERVAL_MS must be a positive number");

await ensureDir(statePath);
await ensureDir(timelinePath);

if (args.check) {
  await runCheck();
} else if (args.once) {
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

async function runCheck() {
  const constitution = await loadConstitution();
  let cmc = null;
  let twak = null;
  try {
    const cmcConn = createCmcMarketSource();
    const twakConn = createTrustWalletWallet({
      reserveAsset,
      tokenAddresses,
      ...(process.env.AGENT_WALLET_ADDRESS ? { address: process.env.AGENT_WALLET_ADDRESS } : {}),
    });
    cmc = cmcConn.transport;
    twak = twakConn.transport;

    // TWAK's stdio server handles wallet calls serially; keep preflight ordering explicit.
    console.error("preflight: checking wallet portfolio");
    const portfolio = await twakConn.wallet.getPortfolio();
    console.error("preflight: checking token risk");
    const tokenRiskScore = await twakConn.wallet.getTokenRiskScore(assets[0]);
    console.error("preflight: checking CMC market data");
    const market = await cmcConn.source.getMarketData(assets[0]);
    console.log(
      JSON.stringify({
        ok: true,
        agentId: constitution.agentId,
        walletAddress: constitution.walletAddress,
        assetChecked: assets[0],
        equityUsd: portfolio.equityUsd,
        reserveUsd: portfolio.reserveUsd,
        marketPriceUsd: market.priceUsd,
        tokenRiskScore,
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
  const state = (await loadState(statePath)) ?? initState(0, now);

  let cmc = null;
  let twak = null;
  try {
    const cmcConn = createCmcMarketSource();
    const twakConn = createTrustWalletWallet({
      reserveAsset,
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
      config: {
        strategy: DEFAULT_STRATEGY,
        sizing: {
          baseTradeUsd: Number(process.env.AGENT_BASE_TRADE_USD ?? 4),
          minStrengthToTrade: Number(process.env.AGENT_MIN_STRENGTH ?? 0.3),
        },
        assets,
      },
      now,
    });

    await saveState(statePath, tick.state);
    const summary = summarizeTick(tick);
    await appendJsonl(timelinePath, summary);
    console.log(JSON.stringify(summary));
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
  if (requireSigned) {
    const verification = await verifyConstitution(constitution, { requireSignerIsWallet });
    if (!verification.valid) throw new Error(`constitution signature invalid: ${verification.reason ?? "unknown"}`);
  }
  return constitution;
}

async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return null;
    throw e;
  }
}

async function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

function summarizeTick(tick) {
  return {
    kind: "tick",
    now: tick.now,
    note: tick.note,
    killSwitch: tick.killSwitchEngaged,
    equityUsd: tick.portfolioAfter.equityUsd,
    reserveUsd: tick.portfolioAfter.reserveUsd,
    tradesToday: tick.state.tradesToday,
    results: tick.results.map((r) => ({
      asset: r.asset,
      signal: r.signal.action,
      allowed: r.decision?.allowed ?? false,
      clamped: (r.decision?.adjustments.length ?? 0) > 0,
      txHash: r.fill?.txHash ?? null,
      filledUsd: r.fill?.filledUsd ?? null,
      denial: r.decision && !r.decision.allowed ? r.decision.violations[0]?.code ?? null : null,
      error: r.error,
    })),
  };
}

async function appendJsonl(file, value) {
  await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
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
