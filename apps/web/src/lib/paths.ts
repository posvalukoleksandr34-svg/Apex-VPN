/**
 * A post-sign-in destination taken from the query string: only a path on
 * this site. Anything else (another host, a protocol-relative `//host`, a
 * backslash trick) is dropped, so the parameter can't be an open redirect.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, "https://apexy.invalid");
    if (url.origin !== "https://apexy.invalid") return null;
    if (url.pathname.startsWith("/login") || url.pathname.startsWith("/auth/")) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}
