"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import type { Snapshot, TickView, AssetView } from "@/lib/session";
import type { LiveEnvelope } from "@/lib/live";
import { Logo, LOGO_NODE_CLASS, LOGO_TRACE_CLASS, LOGO_SWITCH_CLASS } from "@/components/brand/Logo";
import { AnimatedNumber } from "@/components/AnimatedNumber";

gsap.registerPlugin(useGSAP, ScrollTrigger);

// Stable formatters (identity matters — AnimatedNumber takes `format` as a dep).
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtInt = (n: number) => `${Math.round(n)}`;
const fmt = fmtUsd;

const NO_PREF = "(prefers-reduced-motion: no-preference)";

async function call<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const res = await fetch(path, { method, cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export default function Page() {
  const [mode, setMode] = useState<"live" | "demo">("live");
  const [demoSnap, setDemoSnap] = useState<Snapshot | null>(null);
  const [live, setLive] = useState<LiveEnvelope | null>(null);
  const [liveLoaded, setLiveLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);

  const refreshDemo = useCallback(async () => setDemoSnap(await call<Snapshot>("/api/state", "GET")), []);
  const refreshLive = useCallback(async () => {
    try {
      setLive(await call<LiveEnvelope>("/api/live", "GET"));
    } catch {
      setLive(null);
    } finally {
      setLiveLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refreshDemo();
    void refreshLive();
  }, [refreshDemo, refreshLive]);
  useEffect(() => {
    if (mode !== "live") return;
    const timer = window.setInterval(() => void refreshLive(), 30_000);
    return () => window.clearInterval(timer);
  }, [mode, refreshLive]);

  const run = useCallback(async (path: string, times = 1) => {
    setBusy(true);
    try {
      let s: Snapshot | null = null;
      for (let i = 0; i < times; i++) s = await call<Snapshot>(path, "POST");
      if (s) setDemoSnap(s);
    } finally {
      setBusy(false);
    }
  }, []);

  const snap = mode === "live" ? live?.snapshot ?? null : demoSnap;
  const loaded = snap != null;
  const latest = snap?.timeline[0]?.index ?? 0;

  // ── Intro: logo path-draw + node pulse, then staggered hero entrance. Runs once. ──
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const q = gsap.utils.selector(root);
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

        const trace = q(`.${LOGO_TRACE_CLASS}`)[0] as unknown as SVGPathElement | undefined;
        const sw = q(`.${LOGO_SWITCH_CLASS}`)[0] as unknown as SVGLineElement | undefined;
        const node = q(`.${LOGO_NODE_CLASS}`)[0] as unknown as SVGCircleElement | undefined;

        if (trace) {
          const l = trace.getTotalLength();
          gsap.set(trace, { strokeDasharray: l, strokeDashoffset: l });
          tl.to(trace, { strokeDashoffset: 0, duration: 0.9, ease: "power2.inOut" }, 0);
        }
        if (sw) {
          const l = sw.getTotalLength();
          gsap.set(sw, { strokeDasharray: l, strokeDashoffset: l });
          tl.to(sw, { strokeDashoffset: 0, duration: 0.4 }, 0.62);
        }
        if (node) {
          tl.fromTo(node, { scale: 0, svgOrigin: "26.19 11.88" }, { scale: 1, duration: 0.5, ease: "back.out(2.4)" }, 0.74)
            .to(node, { opacity: 0.4, duration: 0.45, yoyo: true, repeat: 1, ease: "sine.inOut" }, ">-0.05");
        }

        tl.from(q(".ct-wordmark"), { opacity: 0, x: -8, duration: 0.5 }, 0.35)
          .from(q(".hero .kicker"), { opacity: 0, y: 14, duration: 0.5 }, 0.45)
          .from(q(".hero h1"), { opacity: 0, y: 20, duration: 0.65 }, "<0.05")
          .from(q(".hero .lede"), { opacity: 0, y: 14, duration: 0.5 }, "<0.12")
          .from(q(".chip"), { opacity: 0, y: 8, stagger: 0.06, duration: 0.4 }, "<");
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  // ── First data paint: banner, counters, controls, and scroll-revealed panels. ──
  useGSAP(
    () => {
      if (!loaded) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const q = gsap.utils.selector(root);
        gsap.from(q(".banner"), { opacity: 0, y: 10, duration: 0.5, ease: "power2.out" });
        gsap.from(q(".card"), { opacity: 0, y: 16, stagger: 0.07, duration: 0.5, ease: "power3.out", delay: 0.05 });
        gsap.from(q(".controls button"), { opacity: 0, y: 10, stagger: 0.05, duration: 0.4, delay: 0.2 });
        q(".reveal").forEach((el) => {
          gsap.from(el, {
            opacity: 0,
            y: 24,
            duration: 0.6,
            ease: "power3.out",
            scrollTrigger: { trigger: el as Element, start: "top 88%" },
          });
        });
      });
      return () => mm.revert();
    },
    { dependencies: [loaded], scope: root },
  );

  // ── Verdict timeline centerpiece: sequence the newest tick — row → verdict chip. ──
  useGSAP(
    () => {
      if (!latest) return;
      const mm = gsap.matchMedia();
      mm.add(NO_PREF, () => {
        const first = root.current?.querySelector(".timeline .tick");
        if (!first) return;
        const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
        tl.from(first, { opacity: 0, y: -12, duration: 0.45 })
          .from(first.querySelectorAll(".row"), { opacity: 0, x: -10, stagger: 0.12, duration: 0.4 }, "<0.12")
          .from(
            first.querySelectorAll(".badge"),
            { scale: 0.6, opacity: 0, stagger: 0.12, duration: 0.35, ease: "back.out(2.2)" },
            "<",
          );
      });
      return () => mm.revert();
    },
    { dependencies: [latest], scope: root },
  );

  // ── "Trigger crash" circuit-breaker beat — the demo's emotional peak. ──
  const { contextSafe } = useGSAP({ scope: root });
  const playCrashBeat = contextSafe(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const q = gsap.utils.selector(root);
    const node = q(`.${LOGO_NODE_CLASS}`)[0];
    const tl = gsap.timeline();
    if (flash.current) {
      tl.fromTo(flash.current, { opacity: 0 }, { opacity: 0.2, duration: 0.07, yoyo: true, repeat: 3, ease: "power1.inOut" }, 0);
    }
    tl.fromTo(root.current, { x: 0 }, { x: 5, duration: 0.045, repeat: 9, yoyo: true, ease: "none" }, 0).set(root.current, { x: 0 });
    if (node) {
      tl.to(node, { fill: "var(--deny)", scale: 1.6, svgOrigin: "26.19 11.88", duration: 0.18, yoyo: true, repeat: 1, ease: "power2.inOut" }, 0);
    }
  });

  const onCrash = useCallback(() => {
    playCrashBeat();
    void run("/api/crash");
  }, [playCrashBeat, run]);

  const tripped = snap?.killSwitch.engaged ?? false;
  const liveStale = live ? Date.now() - Date.parse(live.updatedAt) > 30 * 60 * 1000 : false;

  return (
    <div className="wrap" ref={root}>
      <div className="breaker-flash" ref={flash} aria-hidden />

      <div className="topbar">
        <Logo variant="lockup" size={30} />
        <div className="chips">
          <span className="chip">BNB Chain</span>
          <span className="chip">CoinMarketCap</span>
          <span className="chip">Trust Wallet</span>
        </div>
      </div>

      <div className="hero">
        <p className="kicker">Autonomous · Constitution-gated · BNB Chain</p>
        <h1>
          Survival is <span className="accent">the edge</span>.
        </h1>
        <p className="lede">
          An autonomous trading agent that <strong>cannot trade unless its own signed risk constitution allows it</strong>. The LLM proposes; the
          constitution disposes. The drawdown cap mirrors the competition&apos;s DQ gate.
        </p>
      </div>

      <div className="mode-switch" role="group" aria-label="Dashboard data source">
        <button className={mode === "live" ? "selected" : ""} aria-pressed={mode === "live"} onClick={() => setMode("live")}>Live</button>
        <button className={mode === "demo" ? "selected" : ""} aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>Demo</button>
      </div>

      {!snap ? (
        <div className="empty">
          {mode === "live" && liveLoaded ? "Awaiting the first worker snapshot." : "Loading…"}
        </div>
      ) : (
        <>
          {tripped ? (
            <div className="banner tripped">⛔ CIRCUIT BREAKER TRIPPED — {snap.killSwitch.reason ?? "kill switch engaged"}. Trading halted.</div>
          ) : mode === "live" ? (
            <div className={`banner ${liveStale ? "stale" : "armed"}`}>
              {liveStale ? "STALE" : "LIVE"} — worker snapshot {new Date(live!.updatedAt).toLocaleString()}.
            </div>
          ) : (
            <div className="banner armed">● ARMED — constitution enforced on every order.</div>
          )}

          <Cards snap={snap} tripped={tripped} />

          {mode === "demo" ? (
            <div className="controls">
              <button className="primary" disabled={busy || tripped} onClick={() => run("/api/tick")}>Run tick</button>
              <button disabled={busy || tripped} onClick={() => run("/api/tick", 3)}>Run 3 ticks</button>
              <button className="danger" disabled={busy || tripped} onClick={onCrash}>⚡ Trigger crash</button>
              <button disabled={busy} onClick={() => run("/api/reset")}>Reset</button>
            </div>
          ) : null}

          <div className="section reveal">
            <p className="eyebrow">{mode === "live" ? "Live decision surface" : "Deterministic demonstration"}</p>
            <h2 className="section-title">The constitution, and every verdict it produces.</h2>
          </div>

          <div className="grid2">
            <div className="panel reveal">
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

            <div className="panel reveal">
              <h2>Decision Timeline</h2>
              {snap.timeline.length === 0 ? (
                <div className="empty">
                  {mode === "live" ? "No live decisions have been published yet." : "No ticks yet. Run a tick to start the demonstration."}
                </div>
              ) : (
                <div className="timeline">
                  {snap.timeline.map((t) => (
                    <Tick key={t.index} t={t} />
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="foot reveal">
            {mode === "live"
              ? "Read-only public snapshot from the persistent worker. Wallet credentials and signing material remain on the worker host."
              : "Demo runs on a simulated wallet with a scripted price path. The live worker uses the same policy engine and orchestrator."}
          </div>
        </>
      )}
    </div>
  );
}

function Cards({ snap, tripped }: { snap: Snapshot; tripped: boolean }) {
  const ddClass =
    snap.drawdownPct >= snap.constitution.maxDrawdownPct ? "bad" : snap.drawdownPct > snap.constitution.maxDrawdownPct * 0.6 ? "warn" : "ok";
  const posCount = Object.keys(snap.portfolio.positions).length;
  return (
    <div className="cards">
      <div className="card">
        <div className="label">Equity</div>
        <div className="value">
          <AnimatedNumber value={snap.portfolio.equityUsd} format={fmtUsd} />
        </div>
        <div className="sub">reserve {fmt(snap.portfolio.reserveUsd)}</div>
      </div>
      <div className="card">
        <div className="label">Drawdown</div>
        <div className={`value ${ddClass}`}>
          <AnimatedNumber value={snap.drawdownPct} format={fmtPct} />
        </div>
        <div className="sub">cap {snap.constitution.maxDrawdownPct}% · HWM {fmt(snap.highWaterMarkUsd)}</div>
      </div>
      <div className="card">
        <div className="label">Kill switch</div>
        <div className={`value ${tripped ? "bad" : "ok"}`}>{tripped ? "ENGAGED" : "ARMED"}</div>
        <div className="sub">{snap.tickCount} ticks run</div>
      </div>
      <div className="card">
        <div className="label">Positions</div>
        <div className="value">
          <AnimatedNumber value={posCount} format={fmtInt} />
        </div>
        <div className="sub">{Object.entries(snap.portfolio.positions).map(([a, v]) => `${a} ${fmt(v)}`).join(" · ") || "none"}</div>
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
        <span className="idx">
          #{t.index} · {new Date(t.now).toLocaleTimeString()}
        </span>
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
