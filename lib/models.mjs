/**
 * Grok Build model / reasoning-effort catalogs for Greg UI + CLI args.
 *
 * Live availability comes from `~/.grok/models_cache.json` (filled by the
 * official CLI) when present; otherwise we fall back to a small known list.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description?: string,
 *   default?: boolean,
 *   supportsReasoningEffort?: boolean,
 *   reasoningEfforts?: string[],
 * }} ModelInfo
 */

/** Effort values accepted by Grok Build (`--reasoning-effort` / `--effort`). */
export const EFFORT_LEVELS = Object.freeze([
  { id: "high", label: "High", description: "Highest quality / more reasoning" },
  { id: "medium", label: "Medium", description: "Balanced effort" },
  { id: "low", label: "Low", description: "Quick, fast implementations" },
]);

export const EFFORT_IDS = Object.freeze(
  EFFORT_LEVELS.map((e) => e.id),
);

/**
 * Built-in catalog when the local cache is empty/unavailable.
 * As of 2026-07, Grok Build’s default model is grok-4.5 (Composer is Cursor-side).
 * @type {ModelInfo[]}
 */
export const KNOWN_MODELS = Object.freeze([
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    description: "SpaceXAI frontier model — default in Grok Build",
    default: true,
    supportsReasoningEffort: true,
    reasoningEfforts: ["high", "medium", "low"],
  },
]);

/**
 * @param {string} [path]
 * @returns {string}
 */
export function defaultModelsCachePath(path) {
  if (path) return path;
  return join(homedir(), ".grok", "models_cache.json");
}

/**
 * @param {unknown} raw
 * @returns {"low"|"medium"|"high"|null}
 */
export function normalizeEffort(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "low" || s === "medium" || s === "high") return s;
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeModelId(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return s || null;
}

/**
 * Parse `~/.grok/models_cache.json` shape into ModelInfo[].
 * @param {unknown} doc
 * @returns {ModelInfo[]}
 */
export function modelsFromCacheDoc(doc) {
  if (!doc || typeof doc !== "object") return [];
  const models = /** @type {Record<string, unknown>} */ (doc).models;
  if (!models || typeof models !== "object") return [];

  /** @type {ModelInfo[]} */
  const out = [];
  for (const [id, entry] of Object.entries(
    /** @type {Record<string, unknown>} */ (models),
  )) {
    if (!id || !entry || typeof entry !== "object") continue;
    const info =
      /** @type {Record<string, unknown>} */ (entry).info &&
      typeof /** @type {Record<string, unknown>} */ (entry).info === "object"
        ? /** @type {Record<string, unknown>} */ (
            /** @type {Record<string, unknown>} */ (entry).info
          )
        : /** @type {Record<string, unknown>} */ (entry);

    if (info.hidden === true) continue;

    const name =
      (typeof info.name === "string" && info.name.trim()) ||
      (typeof info.model === "string" && info.model.trim()) ||
      id;
    const description =
      typeof info.description === "string" ? info.description : undefined;
    const supportsReasoningEffort = info.supports_reasoning_effort === true;
    /** @type {string[]} */
    let reasoningEfforts = [];
    if (Array.isArray(info.reasoning_efforts)) {
      for (const e of info.reasoning_efforts) {
        if (!e || typeof e !== "object") continue;
        const v =
          /** @type {Record<string, unknown>} */ (e).value ||
          /** @type {Record<string, unknown>} */ (e).id;
        const n = normalizeEffort(v);
        if (n && !reasoningEfforts.includes(n)) reasoningEfforts.push(n);
      }
    }
    if (!reasoningEfforts.length && supportsReasoningEffort) {
      reasoningEfforts = [...EFFORT_IDS];
    }

    out.push({
      id,
      name,
      description,
      default: false,
      supportsReasoningEffort,
      reasoningEfforts,
    });
  }
  return out;
}

/**
 * Merge live/cache models with known fallbacks; prefer live metadata.
 * @param {ModelInfo[]} primary
 * @param {ModelInfo[]} [fallback]
 * @returns {ModelInfo[]}
 */
export function mergeModelLists(primary, fallback = KNOWN_MODELS) {
  /** @type {Map<string, ModelInfo>} */
  const map = new Map();
  for (const m of fallback) {
    if (m?.id) map.set(m.id, { ...m });
  }
  for (const m of primary) {
    if (!m?.id) continue;
    const prev = map.get(m.id);
    map.set(m.id, prev ? { ...prev, ...m, id: m.id } : { ...m });
  }
  // Ensure at least one default flag
  const list = [...map.values()];
  if (list.length && !list.some((m) => m.default)) {
    const prefer = list.find((m) => m.id === "grok-4.5") || list[0];
    prefer.default = true;
  }
  return list.sort((a, b) => {
    if (a.default && !b.default) return -1;
    if (!a.default && b.default) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Load models for the UI (cache → known fallback).
 * @param {{ cachePath?: string }} [opts]
 * @returns {Promise<{ models: ModelInfo[], source: "cache"|"known", defaultModel: string|null }>}
 */
export async function listAvailableModels(opts = {}) {
  const cachePath = defaultModelsCachePath(opts.cachePath);
  try {
    const raw = await readFile(cachePath, "utf8");
    const doc = JSON.parse(raw);
    const fromCache = modelsFromCacheDoc(doc);
    if (fromCache.length) {
      const models = mergeModelLists(fromCache, KNOWN_MODELS);
      const def = models.find((m) => m.default)?.id || models[0]?.id || null;
      return { models, source: "cache", defaultModel: def };
    }
  } catch {
    /* missing/corrupt cache */
  }
  const models = mergeModelLists([], KNOWN_MODELS);
  return {
    models,
    source: "known",
    defaultModel: models.find((m) => m.default)?.id || "grok-4.5",
  };
}
