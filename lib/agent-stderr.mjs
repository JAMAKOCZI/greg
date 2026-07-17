/**
 * Classify / clean `grok agent` stderr before Greg surfaces it in the UI.
 *
 * The agent harness logs many non-fatal diagnostics (MCP OAuth workers, ACP
 * method mismatches). Dumping them raw as system bubbles looks like session
 * failure when the turn still works.
 */

/** CSI / OSC style ANSI sequences (colors, dim, etc.). */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

/**
 * @typedef {"silent"|"noise"|"surface"} StderrClass
 */

/**
 * @param {string} text raw stderr chunk (may include ANSI)
 * @returns {StderrClass}
 *   - silent: empty after trim
 *   - noise: known non-fatal harness chatter — do not show in chat
 *   - surface: show (after stripAnsi)
 */
export function classifyAgentStderr(text) {
  const plain = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (!plain) return "silent";

  // rmcp HTTP MCP OAuth worker died without credentials (Grok Build known path).
  // Prompt still succeeds; only that MCP is unavailable.
  if (
    /AuthorizationRequired/i.test(plain) ||
    (/worker quit with fatal/i.test(plain) &&
      /Transport channel closed/i.test(plain) &&
      /Auth\(/i.test(plain))
  ) {
    return "noise";
  }

  // Common when client notifies methods the agent does not implement
  // (e.g. empty `initialized` / unknown extension). Not a session crash.
  if (/failed to decode/i.test(plain) && /Method not found/i.test(plain)) {
    return "noise";
  }

  // MCP OAuth skip messages (already handled as NeedsInteractiveLogin)
  if (
    /Skipping OAuth MCP in non-interactive mode/i.test(plain) ||
    /NeedsInteractiveLogin/i.test(plain)
  ) {
    return "noise";
  }

  // Per-tool failures are already shown as failed tool cards — stderr duplicates
  // them as red ERROR lines (tool_error: tool_output_error …).
  if (
    /tool_error\s*:/i.test(plain) ||
    /error_kind\s*=\s*"?tool_output_error"?/i.test(plain) ||
    (/\btool_output_error\b/i.test(plain) && /\btool_name\b/i.test(plain))
  ) {
    return "noise";
  }

  // Common read_file transport noise (also on the card)
  if (
    /failed to deserialize response/i.test(plain) ||
    (/IO Error:/i.test(plain) && /deserialize/i.test(plain))
  ) {
    return "noise";
  }

  return "surface";
}

/**
 * @param {string} text
 * @returns {string|null} cleaned text to show, or null to drop
 */
export function filterAgentStderrForUi(text) {
  if (classifyAgentStderr(text) !== "surface") return null;
  const cleaned = stripAnsi(text).trim();
  return cleaned || null;
}
