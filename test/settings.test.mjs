import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsStore,
  normalizeSettings,
  mergeSettings,
  DEFAULT_SETTINGS,
} from "../lib/settings.mjs";

describe("normalizeSettings / mergeSettings", () => {
  it("fills defaults for empty input", () => {
    assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
    assert.deepEqual(normalizeSettings({}), {
      alwaysApprove: false,
      model: "grok-4.5",
      effort: "high",
      defaultCwd: null,
      theme: "dark",
    });
  });

  it("trims model and defaultCwd", () => {
    const s = normalizeSettings({
      alwaysApprove: true,
      model: "  grok-4.5  ",
      effort: "HIGH",
      defaultCwd: " /tmp/p ",
      theme: " light ",
    });
    assert.equal(s.alwaysApprove, true);
    assert.equal(s.model, "grok-4.5");
    assert.equal(s.effort, "high");
    assert.equal(s.defaultCwd, "/tmp/p");
    assert.equal(s.theme, "light");
  });

  it("invalid effort falls back to high", () => {
    assert.equal(normalizeSettings({ effort: "xhigh" }).effort, "high");
  });

  it("merge empty model resets to default", () => {
    const cur = normalizeSettings({ model: "x" });
    const next = mergeSettings(cur, { model: null });
    assert.equal(next.model, "grok-4.5");
  });

  it("merge empty effort resets to high", () => {
    const cur = normalizeSettings({ effort: "low" });
    const next = mergeSettings(cur, { effort: null });
    assert.equal(next.effort, "high");
  });

  it("merge leaves unset fields", () => {
    const cur = normalizeSettings({
      alwaysApprove: true,
      model: "m",
    });
    const next = mergeSettings(cur, { theme: "dark" });
    assert.equal(next.alwaysApprove, true);
    assert.equal(next.model, "m");
    assert.equal(next.theme, "dark");
  });
});

describe("SettingsStore", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let file;
  /** @type {SettingsStore} */
  let store;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-set-"));
    file = join(root, "settings.json");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rm(file, { force: true });
    store = new SettingsStore({ filePath: file });
  });

  it("load returns defaults when file missing", async () => {
    const s = await store.load();
    assert.deepEqual(s, { ...DEFAULT_SETTINGS });
  });

  it("alwaysApprove only true when strictly true", () => {
    assert.equal(normalizeSettings({ alwaysApprove: "false" }).alwaysApprove, false);
    assert.equal(normalizeSettings({ alwaysApprove: "true" }).alwaysApprove, false);
    assert.equal(normalizeSettings({ alwaysApprove: true }).alwaysApprove, true);
  });

  it("save + load round-trip", async () => {
    await store.save({
      alwaysApprove: true,
      model: "grok-test",
      defaultCwd: "/home/u/proj",
      theme: "dark",
    });
    store.invalidate();
    const s = await store.load();
    assert.equal(s.alwaysApprove, true);
    assert.equal(s.model, "grok-test");
    assert.equal(s.defaultCwd, "/home/u/proj");
    const raw = await readFile(file, "utf8");
    assert.ok(JSON.parse(raw).model === "grok-test");
  });

  it("update patches partially", async () => {
    await store.save({ alwaysApprove: false, model: "a" });
    await store.update({ alwaysApprove: true });
    const s = await store.load();
    assert.equal(s.alwaysApprove, true);
    assert.equal(s.model, "a");
  });

  it("serializes concurrent updates", async () => {
    await store.save({ alwaysApprove: false, model: null });
    await Promise.all([
      store.update({ alwaysApprove: true }),
      store.update({ model: "m1" }),
      store.update({ defaultCwd: "/x" }),
    ]);
    store.invalidate();
    const s = await store.load();
    assert.equal(s.alwaysApprove, true);
    assert.equal(s.model, "m1");
    assert.equal(s.defaultCwd, "/x");
  });
});
