import type { AnimationEventHandler } from "react";

export function SparkOutline({ variant, lap, onAnimationEnd }: {
  variant: "input" | "output" | "model";
  lap?: number;
  onAnimationEnd?: AnimationEventHandler<SVGRectElement>;
}) {
  return (
    <svg
      className={variant === "model" ? "chat-card-spark token-flow-model-spark" : "chat-card-spark"}
      data-card-spark={variant === "model" ? undefined : variant}
      aria-hidden="true"
    >
      <rect key={lap} x="1" y="1" pathLength="100" onAnimationEnd={onAnimationEnd} />
    </svg>
  );
}
