/**
 * emoji.ts — the decorative food glyph a menu tile shows on its colour panel.
 *
 * LAYER: UI (presentation). This file is data about NOTHING: the contract has
 * no image field and no emoji field, so — exactly like the gradient class-hash
 * in `CatalogGrid.tsx` — it invents a LOOK from the name the tile already
 * shows. It is deterministic (the same name draws the same glyph on every
 * terminal and after every re-render) and it claims nothing beyond decoration:
 * a rule mapping กาแฟ → ☕ is a pretty coincidence waiting to be wrong on some
 * shop's "กาแฟดำไม่ใส่น้ำตาล", and the fallback exists precisely because that
 * wrongness is harmless when nothing was ever asserted about the product.
 *
 * WHY KEYWORDS FIRST, HASH SECOND: a straight hash over a six-glyph set lands
 * 🍔 on a latte about one tile in six — on a real menu that reads as a bug, not
 * as decoration. Thai menu names group by the words customers actually say
 * (กาแฟ, ชา, เบอร์เกอร์), so keywords take the common cases, and the hash
 * answers the cases no rule has heard of — still stable, still only decoration.
 *
 * @see ./CatalogGrid.tsx — where the glyph is drawn, inside the aria-hidden
 *      media span so it never enters a tile's accessible name
 */

/**
 * Keyword rules, FIRST MATCH WINS — so order is semantic: a combo named
 * "สมูทตี้เบอร์เกอร์คอมโบ" must hit คอมโบ before either word inside it, and
 * "ชานม" must hit the ชากroup before the นม one. Keywords match against the
 * tile's `name_th` lowercased; Thai has no case, and the lowercasing exists for
 * the English keywords, which catch menus that spell a name in the Thai column.
 */
const KEYWORD_RULES: ReadonlyArray<{
  readonly keywords: readonly string[];
  readonly emoji: string;
}> = [
  { keywords: ['คอมโบ', 'เซ็ต', 'ชุด', 'combo', 'set'], emoji: '🍱' },
  {
    keywords: [
      'กาแฟ',
      'ลาเต้',
      'มอคค่า',
      'คาปูชิโน',
      'อเมริกาโน',
      'espresso',
      'latte',
      'mocha',
      'coffee',
    ],
    emoji: '☕',
  },
  { keywords: ['ชาไทย', 'ชานม', 'ชาเขียว', 'มัทฉะ', 'matcha', 'ชา'], emoji: '🍵' },
  { keywords: ['นม', 'milk'], emoji: '🥛' },
  { keywords: ['น้ำเปล่า', 'น้ำดื่ม', 'water'], emoji: '💧' },
  { keywords: ['เค้ก', 'ขนมหวาน', 'cake'], emoji: '🍰' },
  {
    keywords: ['เบเกอรี่', 'เบเกิล', 'ขนมปัง', 'ครัวซองต์', 'bagel', 'croissant', 'bread'],
    emoji: '🥐',
  },
  { keywords: ['ซุป', 'soup'], emoji: '🍲' },
  { keywords: ['เบอร์เกอร์', 'burger'], emoji: '🍔' },
  { keywords: ['แซนด์วิช', 'แซนวิช', 'sandwich'], emoji: '🥪' },
  { keywords: ['ก๋วยเตี๋ยว', 'บะหมี่', 'ราเมง', 'noodle', 'ramen', 'เส้น'], emoji: '🍜' },
  { keywords: ['สลัด', 'salad'], emoji: '🥗' },
  { keywords: ['ข้าว', 'rice'], emoji: '🍚' },
  { keywords: ['พิซซ่า', 'pizza'], emoji: '🍕' },
  { keywords: ['ผลไม้', 'กล้วย', 'ส้ม', 'เบอร์รี่', 'berry'], emoji: '🍓' },
  { keywords: ['น้ำ', 'สมูทตี้', 'juice', 'smoothie'], emoji: '🥤' },
];

/**
 * What a name no rule has heard of may draw. Order matters only through the
 * hash below — these are equals, not a ranking.
 */
const FALLBACK_GLYPHS: readonly string[] = ['🍽️', '🥤', '🧁', '🍜', '🥗', '🧋'];

/** What an empty name draws — see the floor note in the fallback below. */
const EMPTY_GLYPH = '🍽️';

/**
 * The decorative glyph for a Thai product name. Never empty, always stable.
 */
export function emojiForName(nameTh: string): string {
  const needle = nameTh.trim().toLowerCase();

  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => needle.includes(keyword))) {
      return rule.emoji;
    }
  }

  // A character-code sum, the same TECHNIQUE as the gradient hash in
  // `CatalogGrid.tsx` but a different rule over a different input (name, not
  // variant id) — the two are independent decorative choices, not two
  // implementations of one. Determinism is the requirement; uniformity is not,
  // and this runs once per tile per render over a menu of tens.
  let sum = 0;
  for (let i = 0; i < needle.length; i += 1) {
    sum += needle.charCodeAt(i);
  }

  // The `??` chain is the type-safe indexing the repo's strict settings want
  // (`noUncheckedIndexedAccess`), and the final `?? EMPTY_GLYPH` is the honest
  // floor: an empty name hashes to index 0 anyway, but a glyph is never allowed
  // to be absent — an empty tile panel would read as a broken image.
  return FALLBACK_GLYPHS[sum % FALLBACK_GLYPHS.length] ?? EMPTY_GLYPH;
}