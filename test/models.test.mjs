import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeEffort,
  normalizeModelId,
  modelsFromCacheDoc,
  mergeModelLists,
  listAvailableModels,
  KNOWN_MODELS,
  EFFORT_IDS,
} from "../lib/models.mjs";

describe("normalizeEffort / normalizeModelId", () => {
  it("accepts low/medium/high case-insensitively", () => {
    assert.equal(normalizeEffort("low"), "low");
    assert.equal(normalizeEffort("MEDIUM"), "medium");
    assert.equal(normalizeEffort(" High "), "high");
  });

  it("rejects unknown effort", () => {
    assert.equal(normalizeEffort("xhigh"), null);
    assert.equal(normalizeEffort(""), null);
    assert.equal(normalizeEffort(null), null);
  });

  it("trims model ids", () => {
    assert.equal(normalizeModelId("  grok-4.5  "), "grok-4.5");
    assert.equal(normalizeModelId(""), null);
  });
});

describe("modelsFromCacheDoc / listAvailableModels", () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-models-"));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses cache with grok-4.5 and efforts", () => {
    const list = modelsFromCacheDoc({
      models: {
        "grok-4.5": {
          info: {
            id: "grok-4.5",
            name: "Grok 4.5",
            description: "frontier",
            supports_reasoning_effort: true,
            reasoning_efforts: [
              { value: "high", default: true },
              { value: "medium" },
              { value: "low" },
            ],
          },
        },
      },
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "grok-4.5");
    assert.deepEqual(list[0].reasoningEfforts, ["high", "medium", "low"]);
  });

  it("skips hidden models", () => {
    const list = modelsFromCacheDoc({
      models: {
        secret: { info: { name: "Secret", hidden: true } },
        "grok-4.5": { info: { name: "Grok 4.5", hidden: false } },
      },
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "grok-4.5");
  });

  it("merges known fallbacks", () => {
    const merged = mergeModelLists([], KNOWN_MODELS);
    assert.ok(merged.some((m) => m.id === "grok-4.5"));
    assert.ok(EFFORT_IDS.includes("low"));
  });

  it("listAvailableModels reads cache file", async () => {
    const cachePath = join(root, "models_cache.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        models: {
          "grok-4.5": {
            info: {
              name: "Grok 4.5",
              supports_reasoning_effort: true,
              reasoning_efforts: [{ value: "low" }, { value: "high" }],
            },
          },
        },
      }),
    );
    const r = await listAvailableModels({ cachePath });
    assert.equal(r.source, "cache");
    assert.ok(r.models.some((m) => m.id === "grok-4.5"));
  });

  it("listAvailableModels falls back when cache missing", async () => {
    const r = await listAvailableModels({
      cachePath: join(root, "nope.json"),
    });
    assert.equal(r.source, "known");
    assert.ok(r.models.some((m) => m.id === "grok-4.5"));
  });
});
