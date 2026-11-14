/**
 * Levenshtein distance for lookalike payee detection.
 *
 * A payee address that differs from an allowlisted address by only one or
 * two characters is almost certainly a typo - or a lookalike scam address.
 * spendgate never auto-allows it: it returns REVIEW so a human looks first.
 * An identical address is NOT a lookalike (it is the allowlist itself).
 */

/** Classic dynamic-programming Levenshtein distance (small strings only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Find the allowlisted address closest to `payee` (hex compared without the
 * 0x prefix, case-insensitive). Returns null when there is no allowlist
 * entry within `maxDistance`, or when the payee equals an entry exactly.
 */
export function findLookalike(
  payee: string,
  allowlist: string[],
  maxDistance: number,
): { address: string; distance: number } | null {
  const needle = payee.toLowerCase().replace(/^0x/, "");
  let best: { address: string; distance: number } | null = null;
  for (const entry of allowlist) {
    const candidate = entry.toLowerCase().replace(/^0x/, "");
    if (candidate === needle) return null; // exact match is allowlisted, not lookalike
    const distance = levenshtein(needle, candidate);
    if (distance >= 1 && distance <= maxDistance) {
      if (best === null || distance < best.distance) {
        best = { address: entry, distance };
      }
    }
  }
  return best;
}
