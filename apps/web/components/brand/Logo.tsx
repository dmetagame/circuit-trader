import type { CSSProperties } from "react";

/**
 * Circuit Trader brand mark — the "breaker loop".
 *
 * A continuous circuit trace forms a closed feedback loop (rounded ring) with a deliberate
 * break on the right: an OPEN circuit-breaker arm sitting between two terminals. Open breaker
 * = the gate is open = no current flows = the agent cannot trade. The whole identity in one mark.
 *
 * Grid-constructed on a 32×32 box, single consistent stroke weight matched to the wordmark,
 * round caps/joins, driven entirely by `currentColor` so it themes cleanly (dark / light / mono)
 * and stays legible at 16px. The trace + node carry stable class names so motion can draw them on.
 */

export interface LogoProps {
  /** "lockup" = mark + wordmark; "mark" = glyph only (favicon / app icon). */
  variant?: "lockup" | "mark";
  /** Force a single-color (monochrome) rendering — everything inherits `currentColor`. */
  mono?: boolean;
  /** Pixel height of the mark; wordmark scales with it in the lockup. */
  size?: number;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

export const LOGO_TRACE_CLASS = "ct-logo-trace";
export const LOGO_NODE_CLASS = "ct-logo-node";
export const LOGO_SWITCH_CLASS = "ct-logo-switch";

function Mark({ size = 28, mono = false, title }: { size?: number; mono?: boolean; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label={title ?? "Circuit Trader"}
      style={{ display: "block", flexShrink: 0 }}
    >
      {/* Closed feedback loop, broken on the right (the gate). 316° arc, round-capped. */}
      <path
        className={LOGO_TRACE_CLASS}
        d="M26.19 11.88 A 11 11 0 1 0 26.19 20.12"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Open breaker arm: pivots off the lower terminal, swung away from the top node. */}
      <line
        className={LOGO_SWITCH_CLASS}
        x1="26.19"
        y1="20.12"
        x2="22.4"
        y2="14.9"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      {/* Top terminal / via — the node at the gate. Accent in full-color mode. */}
      <circle
        className={LOGO_NODE_CLASS}
        cx="26.19"
        cy="11.88"
        r="2.1"
        fill={mono ? "currentColor" : "var(--accent, currentColor)"}
      />
    </svg>
  );
}

export function Logo({ variant = "lockup", mono = false, size = 28, className, style, title }: LogoProps) {
  if (variant === "mark") {
    return (
      <span className={className} style={{ display: "inline-flex", color: "currentColor", ...style }}>
        <Mark size={size} mono={mono} title={title} />
      </span>
    );
  }
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: size * 0.38, color: "currentColor", ...style }}
    >
      <Mark size={size} mono={mono} title={title} />
      <span
        className="ct-wordmark"
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          fontSize: size * 0.74,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          whiteSpace: "nowrap",
        }}
      >
        Circuit<span style={{ color: "var(--accent)" }}> Trader</span>
      </span>
    </span>
  );
}

export default Logo;
