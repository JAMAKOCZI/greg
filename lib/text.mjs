/**
 * Pure text helpers shared by server and tests.
 */

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
