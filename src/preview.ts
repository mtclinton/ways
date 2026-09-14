export const PREVIEW_ALLOWLIST = ["public/index.html", "index.html"] as const;
export type PreviewPath = (typeof PREVIEW_ALLOWLIST)[number];

/** Max UTF-8 bytes of static HTML stored for GET /preview (Slice 1.4.1). */
export const PREVIEW_STORE_CAP_BYTES = 256 * 1024;

export type PreviewReady = { status: "ready"; path: PreviewPath };
export type PreviewSkipped = {
  status: "skipped";
  reason: "no-static-index" | "too-large";
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

/**
 * Slice 1.4.1 — decide whether to persist HTML for GET /preview.
 * Cap is exclusive upper bound: size > cap → too-large (do not store).
 */
export function decidePreviewStore(
  byteLength: number,
): "store" | "too-large" {
  if (!Number.isFinite(byteLength) || byteLength < 0) return "too-large";
  return byteLength > PREVIEW_STORE_CAP_BYTES ? "too-large" : "store";
}

/** UTF-8 byte length of a string (for cap check). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Pure helper: ready + too-large → skipped; otherwise leave preview as-is.
 * Used by capture path and unit tests (store-then-serve after fake destroy).
 */
export function applyPreviewStoreDecision(
  preview: PreviewInfo,
  decision: "store" | "too-large",
): PreviewInfo {
  if (preview.status === "ready" && decision === "too-large") {
    return { status: "skipped", reason: "too-large" };
  }
  return preview;
}

export const PREVIEW_HTML_STORAGE_KEY = "previewHtml";
