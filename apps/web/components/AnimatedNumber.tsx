"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

/**
 * A number that counts to its target with GSAP and renders in the mono font with tabular
 * figures, so the width never jitters as digits change. Re-animates whenever `value` changes
 * (e.g. equity / drawdown updating after a tick). Respects prefers-reduced-motion: snaps
 * straight to the value with no tween.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 0.7,
  className,
}: {
  value: number;
  /** Render a number as its display string (e.g. `(n) => \`$${n.toFixed(2)}\``). */
  format: (n: number) => string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const current = useRef(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = current.current;
    if (reduced || from === value) {
      el.textContent = format(value);
      current.current = value;
      return;
    }

    const obj = { n: from };
    const tween = gsap.to(obj, {
      n: value,
      duration,
      ease: "power2.out",
      onUpdate: () => {
        el.textContent = format(obj.n);
      },
      onComplete: () => {
        current.current = value;
      },
    });
    return () => {
      tween.kill();
      current.current = value;
    };
  }, [value, duration, format]);

  return (
    <span ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {format(value)}
    </span>
  );
}

export default AnimatedNumber;
