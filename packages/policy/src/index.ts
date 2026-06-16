export {
  ConstitutionSchema,
  parseConstitution,
  canonicalize,
  type Constitution,
} from "./constitution.js";

export {
  constitutionDigest,
  signConstitution,
  verifyConstitution,
  type VerificationResult,
} from "./signing.js";

export {
  initState,
  rollDay,
  markHighWater,
  recordExecution,
  engageKillSwitch,
  totalNonReserveExposureUsd,
  type RuntimeState,
} from "./state.js";

export { evaluate, type EvaluateArgs } from "./policy-engine.js";

export type {
  TradeProposal,
  TradeSide,
  PolicyDecision,
  Violation,
  ViolationCode,
  Adjustment,
} from "./types.js";

// --- Strategy module ---
export * as indicators from "./strategy/indicators.js";
export {
  generateSignal,
  DEFAULT_STRATEGY,
  type StrategyConfig,
  type Signal,
  type SignalAction,
  type SignalIndicators,
} from "./strategy/signals.js";
export {
  deterministicSynthesizer,
  type Synthesizer,
  type SynthInput,
  type Verdict,
  type SoftContext,
  type RiskLevel,
} from "./strategy/synthesizer.js";
export { claudeSynthesizer, type ClaudeSynthesizerOptions } from "./strategy/claude-synthesizer.js";
export {
  proposeTrade,
  type AssetMarketData,
  type SizingConfig,
  type Quote,
  type ProposeArgs,
  type StrategyOutput,
} from "./strategy/strategy.js";

// --- Execution module ---
export {
  SlippageExceededError,
  type Wallet,
  type QuoteRequest,
  type QuoteResult,
  type SwapOrder,
  type Fill,
  type Portfolio,
} from "./execution/wallet.js";
export { SimulatedWallet, type SimulatedWalletOptions } from "./execution/simulated-wallet.js";
export {
  TrustWalletWallet,
  DEFAULT_TOOL_NAMES,
  type TrustWalletWalletConfig,
  type TwakTransport,
  type TwakToolNames,
} from "./execution/trust-wallet.js";

// --- Orchestrator module ---
export {
  FixtureMarketSource,
  CmcMcpSource,
  DEFAULT_CMC_TOOLS,
  type MarketDataSource,
  type MarketSignals,
  type McpTransport,
  type CmcTools,
  type CmcMcpSourceConfig,
} from "./orchestrator/market-source.js";
export {
  runTick,
  type TickInput,
  type TickResult,
  type AssetTickResult,
  type OrchestratorConfig,
} from "./orchestrator/orchestrator.js";
