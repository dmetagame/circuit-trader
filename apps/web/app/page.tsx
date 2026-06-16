"use client";

import { useCallback, useEffect, useState } from "react";
import type { Snapshot, TickView, AssetView } from "@/lib/session";

const fmt = (n: number) => `$${n.toFixed(2)}`;

async function call(path: string, method: "GET" | "POST"): Promise<Snapshot> {
  const res = await fetch(path, { method, cache: "no-store" });
  return res.json();
}

export default function Page() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setSnap(await call("/api/state", "GET")), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(
    async (path: string, times = 1) => {
      setBusy(true);
      try {
        let s: Snapshot | null = null;
        for (let i = 0; i < times; i++) s = await call(path, "POST");
        if (s) setSnap(s);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (!snap) return <div className="wrap"><div className="empty">Loading…</div></div>;

  const tripped = snap.killSwitch.engaged;
  const ddClass = snap.drawdownPct >= snap.constitution.maxDrawdownPct ? "bad" : snap.drawdownPct > snap.constitution.maxDrawdownPct * 0.6 ? "warn" : "ok";

  return (
    <div className="wrap">
      <div className="header">
        <div className="title">
          Circuit<span className="accent"> Trader</span>
        </div>
        <div className="mono-sm" style={{ color: "var(--muted)" }}>
          BNB Chain · CoinMarketCap · Trust Wallet
        </div>
      </div>
      <div className="tagline">
        An autonomous trading agent that <strong>cannot trade unless its own signed risk constitution allows it</strong>. The LLM proposes; the
        constitution disposes. The drawdown cap mirrors the competition&apos;s DQ gate — survival is the edge.
      </div>

      {tripped ? (
        <div className="banner tripped">⛔ CIRCUIT BREAKER TRIPPED — {snap.killSwitch.reason ?? "kill switch engaged"}. Trading halted.</div>
      ) : (
        <div className="banner armed">● ARMED — constitution enforced on every order.</div>
      )}

      <div className="cards">
        <div className="card">
          <div className="label">Equity</div>
          <div className="value">{fmt(snap.portfolio.equityUsd)}</div>
          <div className="sub">reserve {fmt(snap.portfolio.reserveUsd)}</div>
        </div>
        <div className="card">
          <div className="label">Drawdown</div>
          <div className={`value ${ddClass}`}>{snap.drawdownPct.toFixed(1)}%</div>
          <div className="sub">cap {snap.constitution.maxDrawdownPct}% · HWM {fmt(snap.highWaterMarkUsd)}</div>
        </div>
        <div className="card">
          <div className="label">Kill switch</div>
          <div className={`value ${tripped ? "bad" : "ok"}`}>{tripped ? "ENGAGED" : "ARMED"}</div>
          <div className="sub">{snap.tickCount} ticks run</div>
        </div>
        <div className="card">
          <div className="label">Positions</div>
          <div className="value">{Object.keys(snap.portfolio.positions).length}</div>
          <div className="sub">{Object.entries(snap.portfolio.positions).map(([a, v]) => `${a} ${fmt(v)}`).join(" · ") || "none"}</div>
        </div>
      </div>

      <div className="controls">
        <button className="primary" disabled={busy || tripped} onClick={() => run("/api/tick")}>
          Run tick
        </button>
        <button disabled={busy || tripped} onClick={() => run("/api/tick", 3)}>
          Run 3 ticks
        </button>
        <button className="danger" disabled={busy || tripped} onClick={() => run("/api/crash")}>
          ⚡ Trigger crash
        </button>
        <button disabled={busy} onClick={() => run("/api/reset")}>
          Reset
        </button>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Risk Constitution</h2>
          <Kv k="Agent" v={snap.constitution.agentId} />
          <Kv k="Chain" v={`BNB (${snap.constitution.chainId})`} />
          <Kv k="Wallet" v={`${snap.constitution.walletAddress.slice(0, 6)}…${snap.constitution.walletAddress.slice(-4)}`} />
          <Kv k="Allowed" v={snap.constitution.allowedAssets.join(", ")} />
          <Kv k="Reserve" v={snap.constitution.reserveAsset} />
          <Kv k="Max trade" v={fmt(snap.constitution.maxTradeUsd)} />
          <Kv k="Max drawdown" v={`${snap.constitution.maxDrawdownPct}%`} />
          <Kv k="Min confidence" v={snap.constitution.minSignalConfidence.toFixed(2)} />
          <Kv k="Max token risk" v={String(snap.constitution.maxTokenRiskScore)} />
        </div>

        <div className="panel">
          <h2>Decision Timeline</h2>
          {snap.timeline.length === 0 ? (
            <div className="empty">No ticks yet. Hit “Run tick”, then “Trigger crash” to see the circuit breaker fire.</div>
          ) : (
            <div className="timeline">
              {snap.timeline.map((t) => (
                <Tick key={t.index} t={t} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="foot">
        Demo runs on a simulated wallet with a scripted price path — deterministic and luck-proof. Swap in the Trust Wallet Agent Kit + CoinMarketCap
        MCP adapters for live BNB-chain settlement; the policy engine, strategy, and orchestrator are unchanged.
      </div>
    </div>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

function Tick({ t }: { t: TickView }) {
  return (
    <div className={`tick ${t.killSwitch ? "tripped" : ""}`}>
      <div className="tick-head">
        <span className="idx">#{t.index} · {new Date(t.now).toLocaleTimeString()}</span>
        <span className="eq">
          equity {fmt(t.equityUsd)} · dd {t.drawdownPct.toFixed(1)}%
        </span>
      </div>
      {t.assets.map((a, i) => (
        <Row key={`${t.index}-${a.asset}-${i}`} a={a} />
      ))}
    </div>
  );
}

function Row({ a }: { a: AssetView }) {
  return (
    <div className="row">
      <span className={`badge ${a.status}`}>{a.status}</span>
      <span className="asset">{a.asset}</span>
      <div className="body">
        <div className="headline">{a.headline}</div>
        {a.rationale ? <div className="rationale">{a.rationale}</div> : null}
        {a.txHash ? (
          <div className="tx">
            <a href={`https://bscscan.com/tx/${a.txHash}`} target="_blank" rel="noreferrer">
              {a.txHash.slice(0, 10)}…{a.txHash.slice(-8)} ↗
            </a>
          </div>
        ) : null}
        {a.audit.length > 0 ? (
          <details className="audit">
            <summary>audit ({a.audit.length})</summary>
            <pre>{a.audit.join("\n")}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
