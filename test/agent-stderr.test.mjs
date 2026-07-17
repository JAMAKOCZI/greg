import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyAgentStderr,
  filterAgentStderrForUi,
  stripAnsi,
} from "../lib/agent-stderr.mjs";

describe("stripAnsi", () => {
  it("removes dim/red SGR sequences", () => {
    const raw =
      "\u001b[2m2026-07-17T12:23:43.794484Z\u001b[0m \u001b[31mERROR\u001b[0m boom";
    assert.equal(stripAnsi(raw), "2026-07-17T12:23:43.794484Z ERROR boom");
  });
});

describe("classifyAgentStderr", () => {
  it("marks MCP AuthorizationRequired worker fatal as noise", () => {
    const msg =
      "\u001b[2m2026-07-17T12:23:43.794484Z\u001b[0m \u001b[31mERROR\u001b[0m worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)";
    assert.equal(classifyAgentStderr(msg), "noise");
    assert.equal(filterAgentStderrForUi(msg), null);
  });

  it("marks Method not found decode as noise", () => {
    assert.equal(
      classifyAgentStderr(
        "2026-07-17T12:26:35.607124Z ERROR failed to decode Some(RawValue({})): Method not found",
      ),
      "noise",
    );
  });

  it("surfaces real agent errors", () => {
    const msg = "ERROR panick: out of memory while indexing";
    assert.equal(classifyAgentStderr(msg), "surface");
    assert.equal(filterAgentStderrForUi(msg), msg);
  });

  it("silences empty", () => {
    assert.equal(classifyAgentStderr("  \n"), "silent");
    assert.equal(filterAgentStderrForUi("\u001b[0m  "), null);
  });

  it("marks tool_output_error stderr as noise", () => {
    const msg =
      '2026-07-17T12:50:25.313893Z ERROR tool_error: tool_output_error session_id=019f7020 tool_name="read_file" effective_tool_name="read_file" model_id="grok-4.5" error_kind="tool_output_error"';
    assert.equal(classifyAgentStderr(msg), "noise");
    assert.equal(filterAgentStderrForUi(msg), null);
  });

  it("marks deserialize response IO noise", () => {
    assert.equal(
      classifyAgentStderr(
        'IO Error: Internal error: "failed to deserialize response"',
      ),
      "noise",
    );
  });
});
