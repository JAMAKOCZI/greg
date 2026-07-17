/**
 * Pure text helpers shared by server and tests.
 */

/**
 * True when markdown is empty or only decorative (`---`, blank lines).
 * Used to drop hollow agent bubbles that paint as bare horizontal bars.
 * @param {unknown} md
 * @returns {boolean}
 */
export function isDecorativeOnlyMarkdown(md) {
  const lines = String(md ?? "")
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  return lines.every((l) => /^[-*_]{3,}$/.test(l));
}

/**
 * Build a short session title from the first user prompt.
 * @param {string} text
 * @returns {string}
 */
export function titleFromPrompt(text) {
  const oneLine = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length <= 40) return oneLine;
  return oneLine.slice(0, 40).trimEnd() + "…";
}
