import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import {
  parseConstitution,
  evaluate,
  initState,
  signConstitution,
  verifyConstitution,
  type Constitution,
  type RuntimeState,
  type TradeProposal,
} from "../src/index";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(join(__dirname, "../src/example.constitution.json"), "utf8"));

const NOW = "2026-06-16T12:00:00.000Z";

function constitution(overrides: Partial<Constitution> = {}): Constitution {
  return parseConstitution({ ...RAW, ...overrides });
}

function baseState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return { ...initState(100, NOW), ...overrides };
}

function proposal(overrides: Partial<TradeProposal> = {}): TradeProposal {
  return {
    asset: "BNB",
    side: "buy",
    sizeUsd: 4,
    expectedSlippageBps: 50,
    signalConfidence: 0.8,
    tokenRiskScore: 20,
    rationale: "CMC momentum + funding flip; within risk budget.",
    proposedAt: NOW,
    ...overrides,
  };
}

describe("constitution", () => {
  it("parses the example document", () => {
    const c = constitution();
    expect(c.reserveAsset).toBe("USDT");
    expect(c.allowedAssets).toContain("BNB");
  });

  it("rejects a reserve asset that is not in the allowlist", () => {
    expect(() => constitution({ reserveAsset: "DAI" } as Partial<Constitution>)).toThrow();
  });
});

describe("policy engine — happy path", () => {
  it("ALLOWS a compliant trade", () => {
    const d = evaluate({ constitution: constitution(), state: baseState(), proposal: proposal(), now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.effectiveProposal?.sizeUsd).toBe(4);
    expect(d.violations).toHaveLength(0);
  });
});

describe("policy engine — denials (the demo 'denial' beat)", () => {
  it("DENIES when LLM confidence is below the floor", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState(),
      proposal: proposal({ signalConfidence: 0.5 }),
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("CONFIDENCE_TOO_LOW");
  });

  it("DENIES a risky token (Trust Wallet risk score over ceiling)", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState(),
      proposal: proposal({ tokenRiskScore: 60 }),
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("TOKEN_RISK_TOO_HIGH");
  });

  it("DENIES an asset outside the allowlist", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState(),
      proposal: proposal({ asset: "DOGE" }),
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("ASSET_NOT_ALLOWED");
  });

  it("DENIES while the asset cooldown is active", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState({ lastTradeAtPerAsset: { BNB: "2026-06-16T11:50:00.000Z" } }),
      proposal: proposal(),
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("COOLDOWN_ACTIVE");
  });

  it("DENIES a sell with no position to sell", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState(),
      proposal: proposal({ side: "sell" }),
      now: NOW,
    });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("UNCLAMPABLE");
  });
});

describe("policy engine — clamping", () => {
  it("CLAMPS an oversized trade down to maxTradeUsd", () => {
    const d = evaluate({
      constitution: constitution(),
      state: baseState(),
      proposal: proposal({ sizeUsd: 50 }),
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(d.effectiveProposal?.sizeUsd).toBe(5);
    expect(d.adjustments[0]).toMatchObject({ reason: "ABOVE_MAX_TRADE", from: 50, to: 5 });
  });

  it("CLAMPS to the concentration headroom when that is the binding limit", () => {
    const c = constitution({ perTrade: { minTradeUsd: 2, maxTradeUsd: 100, maxSlippageBps: 75 } } as Partial<Constitution>);
    const state = baseState({ equityUsd: 100, reserveUsd: 70, positions: { BNB: 30 } });
    const d = evaluate({ constitution: c, state, proposal: proposal({ sizeUsd: 50 }), now: NOW });
    expect(d.allowed).toBe(true);
    // concentration cap = 40% * 100 - 30 = 10
    expect(d.effectiveProposal?.sizeUsd).toBe(10);
    expect(d.adjustments[0]?.reason).toBe("CONCENTRATION_EXCEEDED");
  });
});

describe("policy engine — terminal drawdown gate (Track 1 DQ mirror)", () => {
  it("DENIES and engages the kill switch when drawdown breaches the cap", () => {
    const state = baseState({ equityUsd: 70, highWaterMarkUsd: 100, reserveUsd: 70 });
    const d = evaluate({ constitution: constitution(), state, proposal: proposal(), now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.engageKillSwitch).toBe(true);
    expect(d.violations.find((v) => v.code === "DRAWDOWN_BREACH")?.severity).toBe("terminal");
  });

  it("DENIES everything once the kill switch is engaged", () => {
    const state = baseState({ killSwitchEngaged: true, killSwitchReason: "manual stop" });
    const d = evaluate({ constitution: constitution(), state, proposal: proposal(), now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.violations.map((v) => v.code)).toContain("KILL_SWITCH");
  });
});

describe("determinism", () => {
  it("produces identical decisions for identical inputs", () => {
    const args = { constitution: constitution(), state: baseState(), proposal: proposal(), now: NOW };
    expect(evaluate(args)).toEqual(evaluate(args));
  });
});

describe("constitution signing (turns policy into a contract)", () => {
  // Public Hardhat/Anvil test key (account #0) — well-known, holds no funds. Test fixture only.
  const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

  it("signs and verifies, and detects tampering", async () => {
    const account = privateKeyToAccount(PK);
    const c = constitution({ walletAddress: account.address } as Partial<Constitution>);

    const signed = await signConstitution(c, PK);
    expect(signed.signature?.signer.toLowerCase()).toBe(account.address.toLowerCase());

    const ok = await verifyConstitution(signed, { requireSignerIsWallet: true });
    expect(ok.valid).toBe(true);

    // Tamper with a governed limit after signing -> signature must no longer verify.
    const tampered = { ...signed, perTrade: { ...signed.perTrade, maxTradeUsd: 5000 } };
    const bad = await verifyConstitution(tampered);
    expect(bad.valid).toBe(false);
  });
});
