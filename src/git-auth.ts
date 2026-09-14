/**
 * Slice 1.8 — GitHub HTTPS auth helpers.
 * Prefer Authorization header via GITHUB_TOKEN env; never put tokens in RESULT.gitUrl.
 *
 * Git HTTPS with gho_/PAT tokens needs Basic x-access-token (Bearer works for API only).
 */

/** True when url is https and host is github.com (www. allowed). */
export function isGithubHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return host === "github.com" || host === "www.github.com";
  } catch {
    return false;
  }
}

/**
 * Full http.extraHeader value for authenticated git clone.
 * Format: `Authorization: Basic <base64(x-access-token:TOKEN)>`
 * Tests use fake tokens only — never log real tokens.
 */
export function buildGithubAuthExtraHeader(token: string): string {
  if (!token || typeof token !== "string") {
    throw new Error("token required");
  }
  const b64 = btoa(`x-access-token:${token}`);
  return `Authorization: Basic ${b64}`;
}

/** Reject URLs that already embed credentials (userinfo). */
export function assertNoUserinfoInGitUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("gitUrl must be a valid URL");
  }
  if (u.username || u.password) {
    throw new Error("gitUrl must not include userinfo");
  }
}

/**
 * RESULT.gitUrl must always be the original clean https URL.
 * Call before writing RESULT so tokenized clones cannot leak into serialization.
 */
export function resultGitUrl(originalHttpsUrl: string): string {
  assertNoUserinfoInGitUrl(originalHttpsUrl);
  return originalHttpsUrl;
}

/** Replace accidental token echoes in clone stderr (sed-equivalent). */
export function scrubTokenFromText(
  text: string,
  token: string | undefined | null,
): string {
  if (!token || token.length === 0) return text;
  return text.split(token).join("***");
}
