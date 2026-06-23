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
  recordComplianceRoundTrip,
  engageKillSwitch,
  parseRuntimeState,
  totalNonReserveExposureUsd,
  type RuntimeState,
} from "./state.js";

export { evaluate, type EvaluateArgs } from "./policy-engine.js";

export {
  TradeProposalSchema,
  type TradeProposal,
  type TradeSide,
  type PolicyDecision,
  type Violation,
  type ViolationCode,
  type Adjustment,
} from "./types.js";

// --- Strategy module ---
export * as indicators from "./strategy/indicators.js";
export {
  generateSignal,
  signalFromIndicators,
  decideSignal,
  DEFAULT_STRATEGY,
  type StrategyConfig,
  type Signal,
  type SignalAction,
  type SignalIndicators,
  type SignalInputs,
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
  buildProposalFromSignal,
  buildComplianceProposal,
  type ComplianceLegArgs,
  type AssetMarketData,
  type SizingConfig,
  type Quote,
  type SoftSignals,
  type ProposeArgs,
  type BuildProposalArgs,
  type StrategyOutput,
} from "./strategy/strategy.js";

// --- Execution module ---
export {
  ExecutionRejectedError,
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
  CMC_IDS,
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
  type ExecutionIntent,
  type ExecutionObserver,
  ExecutionPersistenceError,
} from "./orchestrator/orchestrator.js";
