// Codex, CodeBuddy, WorkBuddy and Claude Code session logs. Each parser
// returns the same shape DSH uses, so the learner can replay them through
// one extension instance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export function readTextLines(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.pop();
  return lines;
}

const textBlocks = (content) => (Array.isArray(content) ? content : [])
  .filter((block) => (block?.type === "input_text" || block?.type === "output_text" || block?.type === "text") && typeof block.text === "string")
  .map((block) => block.text)
  .join("\n")
  .trim();

const cleanUser = (text) => text
  .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<user_info>[\s\S]*?<\/user_info>/g, "")
  .trim();

function listProjectJsonl(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      out.push({ file: path.join(dir, entry.name), sessionId: entry.name.replace(/\.jsonl$/, "") });
    }
  }
  return out;
}

/** CodeBuddy and WorkBuddy share this JSONL shape. */
export function parseBuddyHeader(lines) {
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.cwd === "string" && row.cwd) {
      return { cwd: row.cwd, createdAt: row.timestamp ?? Date.now() };
    }
  }
  return { cwd: null, createdAt: Date.now() };
}

export function parseBuddyLine(line, index) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type === "message" && (row.role === "user" || row.role === "assistant")) {
    const text = row.role === "user" ? cleanUser(textBlocks(row.content)) : textBlocks(row.content);
    return text ? { seq: index, time: row.timestamp, role: row.role, text, toolNames: [] } : null;
  }
  if (row.type === "function_call" && row.name) {
    return { seq: index, time: row.timestamp, role: "assistant", text: "", toolNames: [row.name] };
  }
  return null;
}

export function listCodeBuddySessions() {
  return listProjectJsonl(path.join(HOME, ".codebuddy", "projects"));
}

export function listWorkBuddySessions() {
  return listProjectJsonl(path.join(HOME, ".workbuddy", "projects"));
}

/** Claude Code sessions share the same <slug>/<uuid>.jsonl layout as CodeBuddy/WorkBuddy. */
export function listClaudeSessions() {
  return listProjectJsonl(path.join(HOME, ".claude", "projects"));
}

export function listCodexSessions() {
  const root = path.join(HOME, ".codex", "sessions");
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl") && !entry.name.includes("_")) {
        const id = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? entry.name;
        out.push({ file: full, sessionId: id });
      }
    }
  };
  walk(root);
  return out;
}

export function parseCodexHeader(lines) {
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== "session_meta") continue;
    const payload = row.payload ?? {};
    return { cwd: payload.cwd ?? null, createdAt: payload.timestamp ?? row.timestamp ?? Date.now() };
  }
  return { cwd: null, createdAt: Date.now() };
}

export function parseCodexLine(line, index) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type !== "response_item") return null;
  const payload = row.payload ?? {};
  if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const text = payload.role === "user" ? cleanUser(textBlocks(payload.content)) : textBlocks(payload.content);
    return text ? { seq: index, time: row.timestamp, role: payload.role, text, toolNames: [] } : null;
  }
  if (payload.type === "custom_tool_call" && payload.name) {
    return { seq: index, time: row.timestamp, role: "assistant", text: "", toolNames: [payload.name] };
  }
  return null;
}

/**
 * Claude Code JSONL: every row carries a top-level `cwd`, `timestamp` and
 * `type` ("user"/"assistant"/"system"/"attachment"/"queue-operation"/
 * "api-request*"). Only "user"/"assistant" rows are real conversation turns;
 * the rest (hook output, request telemetry) are skipped by construction since
 * only those two types are handled below.
 */
export function parseClaudeHeader(lines) {
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row.cwd === "string" && row.cwd) {
      return { cwd: row.cwd, createdAt: row.timestamp ?? Date.now() };
    }
  }
  return { cwd: null, createdAt: Date.now() };
}

export function parseClaudeLine(line, index) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.type !== "user" && row.type !== "assistant") return null;
  const message = row.message;
  if (message?.role !== "user" && message?.role !== "assistant") return null;
  if (message.role === "user") {
    // Real user turns have string content; tool_result turns are a content
    // array with no "text"/"input_text"/"output_text" block, so textBlocks()
    // naturally yields "" for them and they are skipped.
    const raw = typeof message.content === "string" ? message.content : textBlocks(message.content);
    const text = cleanUser(raw.trim());
    return text ? { seq: index, time: row.timestamp, role: "user", text, toolNames: [] } : null;
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = textBlocks(blocks);
  const toolNames = blocks.filter((block) => block?.type === "tool_use" && typeof block.name === "string").map((block) => block.name);
  return text || toolNames.length ? { seq: index, time: row.timestamp, role: "assistant", text, toolNames } : null;
}

export const polledAgents = [
  { name: "codebuddy", list: listCodeBuddySessions, parseHeader: parseBuddyHeader, parseLine: parseBuddyLine },
  { name: "workbuddy", list: listWorkBuddySessions, parseHeader: parseBuddyHeader, parseLine: parseBuddyLine },
  { name: "codex", list: listCodexSessions, parseHeader: parseCodexHeader, parseLine: parseCodexLine },
  { name: "claude", list: listClaudeSessions, parseHeader: parseClaudeHeader, parseLine: parseClaudeLine },
];
