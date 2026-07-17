import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultGrokSessionsDir,
  extractText,
  grokSessionToTranscript,
  listGrokSessions,
  loadGrokSession,
  mapGrokItem,
} from "../lib/grok-sessions.mjs";

describe("defaultGrokSessionsDir", () => {
  it("uses override when provided", () => {
    assert.equal(defaultGrokSessionsDir("/x/sessions"), "/x/sessions");
  });
});

describe("extractText / mapGrokItem", () => {
  it("extracts string and content parts", () => {
    assert.equal(extractText("hello"), "hello");
    assert.equal(
      extractText([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
      "ab",
    );
  });

  it("maps user and skips synthetic reminders", () => {
    const u = mapGrokItem({
      type: "user",
      content: [{ type: "text", text: "Fix the bug" }],
    });
    assert.equal(u.role, "user");
    assert.equal(u.text, "Fix the bug");

    assert.equal(
      mapGrokItem({
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }],
      }),
      null,
    );
    assert.equal(
      mapGrokItem({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>only</system-reminder>" }],
      }),
      null,
    );
  });

  it("maps assistant text + tool_calls", () => {
    const mapped = mapGrokItem({
      type: "assistant",
      content: "Working on it.",
      tool_calls: [
        {
          id: "call-1",
          name: "read_file",
          arguments: '{"path":"a.ts"}',
        },
      ],
    });
    assert.ok(Array.isArray(mapped));
    assert.equal(mapped[0].role, "agent");
    assert.equal(mapped[0].text, "Working on it.");
    assert.equal(mapped[1].role, "tool");
    assert.match(mapped[1].text, /read_file/);
    assert.equal(mapped[1].meta.toolCallId, "call-1");
  });

  it("maps reasoning and tool_result", () => {
    const thought = mapGrokItem({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "Think hard" }],
    });
    assert.equal(thought.role, "thought");
    assert.equal(thought.text, "Think hard");

    const tr = mapGrokItem({
      type: "tool_result",
      tool_call_id: "call-1",
      content: "file contents here",
    });
    assert.equal(tr.role, "tool");
    assert.equal(tr.text, "file contents here");
  });

  it("skips system prompts", () => {
    assert.equal(
      mapGrokItem({ type: "system", content: "You are Grok…" }),
      null,
    );
  });
});

describe("list / load / convert (fixture tree)", () => {
  /** @type {string} */
  let root;
  const sid = "019f6d00-aaaa-bbbb-cccc-ddddeeee0001";

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-grok-imp-"));
    const sessDir = join(root, "%2Ftmp%2Fproj", sid);
    await mkdir(sessDir, { recursive: true });
    await writeFile(
      join(sessDir, "summary.json"),
      JSON.stringify({
        info: { id: sid, cwd: "/tmp/proj" },
        session_summary: "Import Fixture Chat",
        generated_title: "Import Fixture Chat",
        created_at: "2026-07-16T10:00:00.000Z",
        updated_at: "2026-07-16T11:00:00.000Z",
        last_active_at: "2026-07-16T11:00:00.000Z",
        num_chat_messages: 5,
        current_model_id: "grok-4.5",
        session_kind: "local",
        agent_name: "grok-build",
        chat_format_version: 1,
      }),
      "utf8",
    );
    const lines = [
      JSON.stringify({ type: "system", content: "huge system prompt" }),
      JSON.stringify({
        type: "user",
        synthetic_reason: "system_reminder",
        content: [{ type: "text", text: "<system-reminder>mcp</system-reminder>" }],
      }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "Please refactor auth." }],
      }),
      JSON.stringify({
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Plan the refactor" }],
      }),
      JSON.stringify({
        type: "assistant",
        content: "I'll refactor the auth module.",
        tool_calls: [
          { id: "c1", name: "read_file", arguments: '{"path":"auth.ts"}' },
        ],
      }),
      JSON.stringify({
        type: "tool_result",
        tool_call_id: "c1",
        content: "export function login() {}",
      }),
    ];
    await writeFile(join(sessDir, "chat_history.jsonl"), lines.join("\n") + "\n", "utf8");

    // Empty / junk neighbor should not break listing
    await mkdir(join(root, "%2Fother", "not-a-session"), { recursive: true });
    await writeFile(join(root, "session_search.sqlite"), "x", "utf8");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists session from summary.json", async () => {
    const list = await listGrokSessions({ rootDir: root, limit: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sid);
    assert.equal(list[0].cwd, "/tmp/proj");
    assert.equal(list[0].title, "Import Fixture Chat");
    assert.equal(list[0].model, "grok-4.5");
    assert.ok(list[0].updatedAt > 0);
  });

  it("loads and converts to Greg transcript", async () => {
    const loaded = await loadGrokSession(sid, { rootDir: root });
    assert.ok(loaded);
    assert.equal(loaded.summary.id, sid);

    const doc = grokSessionToTranscript(loaded.summary, loaded.items);
    assert.equal(doc.id, sid);
    assert.equal(doc.cwd, "/tmp/proj");
    assert.equal(doc.title, "Import Fixture Chat");
    assert.equal(doc.source.kind, "grok");
    assert.equal(doc.source.sessionId, sid);

    const roles = doc.messages.map((m) => m.role);
    assert.ok(roles.includes("system"));
    assert.ok(roles.includes("user"));
    assert.ok(roles.includes("agent"));
    assert.ok(roles.includes("tool"));
    assert.ok(roles.includes("thought"));

    // No huge system prompt body
    assert.equal(
      doc.messages.some((m) => m.text.includes("huge system prompt")),
      false,
    );
    const user = doc.messages.find((m) => m.role === "user");
    assert.equal(user.text, "Please refactor auth.");
    const agent = doc.messages.find((m) => m.role === "agent");
    assert.match(agent.text, /refactor the auth/);
  });

  it("returns null for unknown id", async () => {
    assert.equal(await loadGrokSession("does-not-exist", { rootDir: root }), null);
  });
});

