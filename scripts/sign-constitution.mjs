#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import {
  constitutionDigest,
  parseConstitution,
  signConstitution,
  verifyConstitution,
} from "circuit-trader-policy";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
await loadEnvFile(args.envFile ?? process.env.ENV_FILE ?? ".env.local");

const input = resolve(args.input ?? process.env.CONSTITUTION_UNSIGNED_PATH ?? "packages/policy/src/example.constitution.json");
const output = resolve(args.output ?? process.env.CONSTITUTION_PATH ?? ".circuit-trader/constitution.signed.json");
const privateKey = process.env.CONSTITUTION_SIGNER_PRIVATE_KEY;

const unsigned = parseConstitution(applyEnvOverrides(JSON.parse(await readFile(input, "utf8"))));
const signed = privateKey
  ? await signConstitution(unsigned, normalizePrivateKey(privateKey))
  : await signWithTwak(unsigned);
const verification = await verifyConstitution(signed, { requireSignerIsWallet: true });
if (!verification.valid) {
  throw new Error(`signed constitution failed wallet-signer verification: ${verification.reason ?? "unknown"}`);
}

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, `${JSON.stringify(signed, null, 2)}\n`, { mode: 0o600 });

console.log(
  JSON.stringify(
    {
      output,
      walletAddress: signed.walletAddress,
      signer: signed.signature?.signer,
      digest: constitutionDigest(signed),
    },
    null,
    2,
  ),
);

async function signWithTwak(unsigned) {
  if (unsigned.chainId !== 56) {
    throw new Error(`TWAK constitution signing currently supports BSC chainId 56, received ${unsigned.chainId}`);
  }

  const digest = constitutionDigest(unsigned);
  const { stdout } = await execFileAsync(
    process.env.TWAK_BIN ?? "twak",
    ["wallet", "sign-message", "--chain", "bsc", "--message", digest, "--json"],
    { env: process.env, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  if (typeof result.address !== "string" || typeof result.signature !== "string") {
    throw new Error("TWAK sign-message returned an invalid response");
  }

  return parseConstitution({
    ...unsigned,
    signature: {
      scheme: "eip191-personal-sign",
      signer: result.address,
      value: result.signature,
    },
  });
}

function applyEnvOverrides(raw) {
  const minTradeUsd = optionalNumber("CONSTITUTION_MIN_TRADE_USD");
  const maxTradeUsd = optionalNumber("CONSTITUTION_MAX_TRADE_USD");
  return {
    ...raw,
    ...(process.env.AGENT_ID ? { agentId: process.env.AGENT_ID } : {}),
    ...(process.env.AGENT_WALLET_ADDRESS ? { walletAddress: process.env.AGENT_WALLET_ADDRESS } : {}),
    perTrade: {
      ...raw.perTrade,
      ...(minTradeUsd == null ? {} : { minTradeUsd }),
      ...(maxTradeUsd == null ? {} : { maxTradeUsd }),
    },
  };
}

function optionalNumber(name) {
  const raw = process.env[name];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function normalizePrivateKey(value) {
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
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
  const out = { input: null, output: null, envFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") out.input = argv[++i] ?? null;
    else if (arg === "--output") out.output = argv[++i] ?? null;
    else if (arg === "--env-file") out.envFile = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}
