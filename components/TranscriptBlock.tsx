import type { ComponentProps } from "react";

/** A visible transcript box, not its surrounding metadata or row spacing. */
export function TranscriptBlock({ kind = "context", ...props }: ComponentProps<"div"> & { kind?: "context" | "response" | null }) {
  return <div {...props} data-transcript-block={kind ?? undefined} />;
}
