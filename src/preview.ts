export const PREVIEW_ALLOWLIST = ["public/index.html", "index.html"] as const;
export type PreviewPath = (typeof PREVIEW_ALLOWLIST)[number];

export type PreviewReady = { status: "ready"; path: PreviewPath };
export type PreviewSkipped = {
  status: "skipped";
  reason: "no-static-index";
};
export type PreviewInfo = PreviewReady | PreviewSkipped;

/** Map filesystem presence to preview RESULT (prefer public/index.html). */
export function resolvePreviewFromExists(
  hasPublicIndex: boolean,
  hasRootIndex: boolean,
): PreviewInfo {
  if (hasPublicIndex) return { status: "ready", path: "public/index.html" };
  if (hasRootIndex) return { status: "ready", path: "index.html" };
  return { status: "skipped", reason: "no-static-index" };
}

/** Allow only the two contract paths; ban traversal. */
export function previewAbsolutePath(rel: string): string | null {
  if (!(PREVIEW_ALLOWLIST as readonly string[]).includes(rel)) return null;
  if (
    rel.includes("..") ||
    rel.includes("\\") ||
    rel.startsWith("/") ||
    rel.includes("\0")
  ) {
    return null;
  }
  return `/workspace/run/src/${rel}`;
}
