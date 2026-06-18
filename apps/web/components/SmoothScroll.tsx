"use client";

import { useEffect, useRef } from "react";
import { ReactLenis, useLenis } from "lenis/react";
import type { LenisRef } from "lenis/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * Premium smooth scroll, synced to the GSAP ticker so scroll-driven animations stay in
 * lockstep with the scroll position (no drift / double-RAF). Disabled outright when the
 * visitor prefers reduced motion — native scrolling, no easing, full keyboard/anchor support.
 *
 * The root layout stays a Server Component; this client island wraps {children}.
 */
export function SmoothScroll({ children }: { children: React.ReactNode }) {
  const lenisRef = useRef<LenisRef>(null);

  // Honour reduced-motion: if set, don't mount Lenis at all (native scroll is fully accessible).
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    function update(time: number) {
      lenisRef.current?.lenis?.raf(time * 1000);
    }
    gsap.ticker.add(update);
    gsap.ticker.lagSmoothing(0);
    return () => {
      gsap.ticker.remove(update);
    };
  }, [reduced]);

  if (reduced) return <>{children}</>;

  return (
    <ReactLenis
      root
      ref={lenisRef}
      options={{
        // Drive RAF from the GSAP ticker above, not Lenis's own loop.
        autoRaf: false,
        duration: 1.05,
        // Subtle, premium ease-out — no rubber-banding.
        easing: (t: number) => 1 - Math.pow(1 - t, 3),
        smoothWheel: true,
      }}
    >
      <ScrollTriggerSync />
      {children}
    </ReactLenis>
  );
}

/** Keep ScrollTrigger's notion of scroll position in step with Lenis. */
function ScrollTriggerSync() {
  const lenis = useLenis(() => ScrollTrigger.update());
  useEffect(() => {
    ScrollTrigger.refresh();
    return () => {
      lenis?.off?.("scroll", ScrollTrigger.update);
    };
  }, [lenis]);
  return null;
}

function useReducedMotion(): boolean {
  const ref = useRef(false);
  if (typeof window !== "undefined") {
    ref.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return ref.current;
}

export default SmoothScroll;
