"use client";
import { useState, type ReactNode } from "react";

export default function SlideOutRow({
  children,
  onRemoved,
}: {
  children: ReactNode;
  onRemoved?: () => void;
}) {
  const [sliding, setSliding] = useState(false);

  function withdraw() {
    setSliding(true);
  }

  return (
    <div
      // Use transform + opacity instead of max-height to avoid continuous
      // layout recalculation on Safari (fixes #551).
      // will-change: transform hints the GPU to promote this layer ahead of time.
      className={sliding ? "slide-out-row" : ""}
      style={{ willChange: sliding ? "transform, opacity" : undefined }}
      onAnimationEnd={sliding ? onRemoved : undefined}
    >
      {typeof children === "function"
        ? (children as (withdraw: () => void) => ReactNode)(withdraw)
        : children}
    </div>
  );
}
