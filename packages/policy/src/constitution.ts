import { z } from "zod";

/**
 * The Risk Constitution.
 *
 * A machine-readable, signable policy contract that defines the *only* conditions
 * under which the agent is permitted to trade. The policy engine evaluates every
 * proposed trade against this document; nothing reaches the chain without passing.
 *
 * Design intent for BNB HACK Track 1: `riskGates.maxDrawdownPct` mirrors the
 * competition's hard disqualification gate. Keeping the constitution's cap at or
 * below the competition threshold is what keeps an unattended agent on the
 * leaderboard while reckless bots blow up.
 */

const AssetSymbol = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Z0-9]+$/, "asset symbols are uppercase alphanumerics, e.g. BNB, USDT");

const EvmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a 20-byte hex EVM address");

export const ConstitutionSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),

    // --- Identity: who this constitution governs ---
    agentId: z.string().min(1),
    chainId: z.number().int().positive(), // 56 = BNB Smart Chain mainnet
    walletAddress: EvmAddress, // the dedicated agent wallet this governs
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable().default(null),

    // --- Trading universe ---
    allowedAssets: z.array(AssetSymbol).min(1).max(20),
    reserveAsset: AssetSymbol.default("USDT"), // the safe asset positions are exited into

    // --- Per-trade limits ---
    perTrade: z.object({
      minTradeUsd: z.number().positive(), // avoids dust; helps meet Track 1 min-trade-count meaningfully
      maxTradeUsd: z.number().positive(),
      maxSlippageBps: z.number().int().min(0).max(10_000), // 100 bps = 1%
    }),

    // --- Risk gates (hard stops) ---
    riskGates: z.object({
      maxDrawdownPct: z.number().positive().max(100), // TERMINAL — engages kill switch (mirrors Track 1 DQ gate)
      dailyLossLimitPct: z.number().positive().max(100), // halts trading for the rest of the UTC day
      minSignalConfidence: z.number().min(0).max(1), // LLM verdict confidence floor
      maxTokenRiskScore: z.number().min(0).max(100), // Trust Wallet token risk score ceiling (higher = riskier)
    }),

    // --- Portfolio limits ---
    portfolio: z.object({
      maxConcentrationPctPerAsset: z.number().positive().max(100), // single-asset cap as % of equity
      maxPortfolioExposurePct: z.number().positive().max(100), // total non-reserve exposure as % of equity
    }),

    // --- Activity & transaction-cost controls ---
    activity: z.object({
      cooldownMinutesPerAsset: z.number().min(0), // no re-trading the same asset inside this window
      minTradeIntervalSeconds: z.number().min(0), // global throttle across all assets
      maxTradesPerDay: z.number().int().positive(), // caps simulated tx-cost bleed
    }),

    // --- Enforcement behaviour ---
    enforcement: z.object({
      clampOversizedTrades: z.boolean().default(true), // size-too-big => reduce to the limit instead of denying
      killSwitch: z.boolean().default(false), // manual master-off; true blocks all trading
    }),

    // --- Signature over the canonical digest (null until signed). See signing.ts ---
    signature: z
      .object({
        scheme: z.literal("eip191-personal-sign"),
        signer: EvmAddress,
        value: z.string().regex(/^0x[a-fA-F0-9]+$/),
      })
      .nullable()
      .default(null),
  })
  .refine((c) => c.perTrade.maxTradeUsd >= c.perTrade.minTradeUsd, {
    message: "perTrade.maxTradeUsd must be >= perTrade.minTradeUsd",
    path: ["perTrade", "maxTradeUsd"],
  })
  .refine((c) => c.allowedAssets.includes(c.reserveAsset), {
    message: "reserveAsset must be listed in allowedAssets",
    path: ["reserveAsset"],
  });

export type Constitution = z.infer<typeof ConstitutionSchema>;

/** Parse + validate raw JSON (e.g. from disk / env) into a typed Constitution. Throws on invalid. */
export function parseConstitution(raw: unknown): Constitution {
  return ConstitutionSchema.parse(raw);
}

/**
 * Deterministic, key-sorted JSON serialization with the `signature` field removed.
 * This is the exact byte string that gets hashed and signed, so signing and
 * verification always agree regardless of original key order or whitespace.
 */
export function canonicalize(c: Constitution): string {
  const { signature: _signature, ...unsigned } = c;
  return stableStringify(unsigned);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
