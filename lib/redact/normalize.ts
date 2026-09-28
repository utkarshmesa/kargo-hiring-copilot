// Normalisation shared by the fidelity check and the quote check: the same text must
// compare equal however Word, the PDF library or Gemini chose to encode it.
const BULLET_GLYPHS = /^[\s\-–—•▪◦●○■□►▸·*‣⁃]+/;

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A bullet as copied by the Extractor, without its leading glyph. */
export function normalizeBullet(s: string): string {
  return normalizeText(stripBulletGlyph(s));
}

export function stripBulletGlyph(s: string): string {
  return s.replace(BULLET_GLYPHS, "");
}
