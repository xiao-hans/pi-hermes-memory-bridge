// Claude Code session-log parsing: only real user/assistant turns become
// messages; hook attachments, request telemetry and tool results do not.
// Rows are synthetic but follow the shapes Claude Code writes to
// ~/.claude/projects/<slug>/<uuid>.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaudeHeader, parseClaudeLine, polledAgents } from "../agent-logs.mjs";

const base = { cwd: "C:\\work\\demo", sessionId: "s1", timestamp: "2026-11-01T02:27:41.255Z" };
const rows = [
  { type: "queue-operation", operation: "enqueue", timestamp: base.timestamp },
  { ...base, type: "attachment", attachment: { type: "hook_additional_context", content: "hook output" } },
  { ...base, type: "user", message: { role: "user", content: "<system-reminder>ctx</system-reminder>发布前跑什么？" } },
  { ...base, type: "api-request", request: { model: "m" } },
  { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] } },
  { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
  { ...base, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file text" }] } },
  { ...base, type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "npm run verify" }] } },
  { ...base, type: "system", subtype: "turn_duration", content: "done" },
].map((row) => JSON.stringify(row));

test("parseClaudeHeader takes cwd and timestamp from the first row that has a cwd", () => {
  assert.deepEqual(parseClaudeHeader(rows), { cwd: base.cwd, createdAt: base.timestamp });
});

test("parseClaudeLine keeps user text, assistant text and tool calls only", () => {
  const parsed = rows.map((line, i) => parseClaudeLine(line, i)).filter(Boolean);
  assert.deepEqual(parsed, [
    { seq: 2, time: base.timestamp, role: "user", text: "发布前跑什么？", toolNames: [] },
    { seq: 5, time: base.timestamp, role: "assistant", text: "", toolNames: ["Read"] },
    { seq: 7, time: base.timestamp, role: "assistant", text: "npm run verify", toolNames: [] },
  ]);
});

test("parseClaudeLine ignores malformed lines", () => {
  assert.equal(parseClaudeLine("{not json", 0), null);
});

test("claude is registered as a polled agent", () => {
  assert.ok(polledAgents.some((agent) => agent.name === "claude" && agent.parseLine === parseClaudeLine));
});
