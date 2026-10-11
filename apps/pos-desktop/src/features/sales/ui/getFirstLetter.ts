/**
 * getFirstLetter — extract the first meaningful Thai consonant from a string.
 *
 * Thai many words start with leading vowels (เ แ โ ใ ไ) which are not standalone
 * consonants. This function skips those and returns the first actual consonant.
 * For English names or empty strings, it falls back appropriately.
 *
 * LAYER: UI presentation only. No domain, no tests in this file — see
 * getFirstLetter.test.ts.
 */

/** Thai leading vowels that should be skipped. */
const THAI_LEADING_VOWELS = new Set(['เ', 'แ', 'โ', 'ใ', 'ไ']);

/**
 * Get the first consonant from a Thai string, skipping leading vowels.
 *
 * Examples:
 *   "เอสเปรสโซ" → "ส"
 *   "กาแฟลาเต้" → "ก"
 *   "มอคค่า" → "ม"
 *   "coffee" → "c"
 *   "" → "?"
 */
export function getFirstLetter(name: string): string {
  if (!name || name.length === 0) {
    return '?';
  }

  // Split into Thai grapheme clusters — Array.from handles combining marks.
  const chars = Array.from(name);

  // Skip leading vowels and non-consonants until we find a Thai consonant.
  for (const ch of chars) {
    // Check if it's a Thai leading vowel — skip it.
    if (THAI_LEADING_VOWELS.has(ch)) {
      continue;
    }

    // Check if it's a Thai consonant (U+0E01 to U+0E2E are Thai consonants).
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0e01 && code <= 0x0e2e) {
      return ch;
    }

    // For non-Thai (English), take the first character.
    return ch;
  }

  // Nothing but leading vowels — no consonant to show, and showing a vowel
  // would defeat the point. Same fallback as an empty name.
  return '?';
}

export default getFirstLetter;
