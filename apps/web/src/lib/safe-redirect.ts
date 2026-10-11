/**
 * Returns `target` only if it is a same-site relative path; otherwise `fallback`.
 * Prevents open redirects through the sign-in `next` parameter.
 */
export function safeRedirectPath(target: string | null | undefined, fallback: string): string {
  if (!target) return fallback;
  if (!target.startsWith("/") || target.startsWith("//") || target.startsWith("/\\"))
    return fallback;
  // Control characters (e.g. newlines) can be normalised away by browsers into "//host".
  for (let i = 0; i < target.length; i++) {
    if (target.charCodeAt(i) < 0x20) return fallback;
  }
  return target;
}
