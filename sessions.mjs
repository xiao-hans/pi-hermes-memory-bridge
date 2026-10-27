// Cursor transcripts -> pi-hermes-memory session index (sessions.db), written
// with the extension's own indexSession() so Pi's session_search sees Cursor
// conversations next to Pi sessions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importExtensionModule, MEMORY_DIR } from "./host.mjs";

export const CURSOR_PROJECTS_DIR = path.join(os.homedir(), ".cursor", "projects");
export const sessionIdFor = (conversationId) => `cursor-${conversationId}`;

const SYSTEM_WRAPPERS = /<(timestamp|system_reminder|system-reminder|system_notification|attached_files|agent_transcripts|user_info|rules)>[\s\S]*?<\/\1>/g;

export function cleanUserText(text) {
  const queries = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)].map((m) => m[1].trim());
  if (queries.length) return queries.join("\n\n");
  return text.replace(SYSTEM_WRAPPERS, "").trim();
}

/** One transcript line -> { role, text, toolNames }, or null for non-message lines. */
export function parseTranscriptLine(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row.role !== "user" && row.role !== "assistant") return null;
  const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
  const raw = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  const text = row.role === "user" ? cleanUserText(raw) : raw;
  const toolNames = blocks.filter((b) => b?.type === "tool_use").map((b) => b.name ?? "tool");
  if (!text && !toolNames.length) return null;
  return { role: row.role, text, toolNames };
}

/** Complete lines only; a trailing partial line is left for the next read. */
export function readCompleteLines(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.pop();
  return lines;
}

/** Main-conversation transcripts (agent-transcripts/<id>/<id>.jsonl); subagent runs are skipped. */
export function listTranscripts() {
  const out = [];
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return out;
  for (const projectDir of fs.readdirSync(CURSOR_PROJECTS_DIR)) {
    const root = path.join(CURSOR_PROJECTS_DIR, projectDir, "agent-transcripts");
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      const file = path.join(root, id, `${id}.jsonl`);
      if (fs.existsSync(file)) out.push({ file, conversationId: id, projectDir });
    }
  }
  return out;
}

function childDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Cursor names project dirs by flattening the workspace path ("C-Users-SUNMI-cursor-x"
 * for C:\Users\SUNMI\.cursor\x), which drops separators, dots and case. Rebuild the
 * path by matching the remaining segments against directories that exist on disk.
 */
export function decodeProjectDir(projectDir) {
  const segments = projectDir.split("-").filter(Boolean);
  if (segments.length === 0 || !/^[a-z]$/i.test(segments[0])) return null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const walk = (dir, rest) => {
    if (rest.length === 0) return dir;
    const children = childDirs(dir);
    for (let take = rest.length; take >= 1; take--) {
      const wanted = norm(rest.slice(0, take).join(""));
      for (const child of children) {
        if (norm(child) !== wanted) continue;
        const found = walk(path.join(dir, child), rest.slice(take));
        if (found) return found;
      }
    }
    return null;
  };

  const drive = `${segments[0].toUpperCase()}:\\`;
  return fs.existsSync(drive) ? walk(drive, segments.slice(1)) : null;
}

let indexerPromise;
function getIndexer() {
  indexerPromise ??= (async () => {
    const [{ DatabaseManager }, { indexSession }] = await Promise.all([
      importExtensionModule("src/store/db.ts"),
      importExtensionModule("src/store/session-indexer.ts"),
    ]);
    const dbManager = new DatabaseManager(MEMORY_DIR);
    return { dbManager, indexSession };
  })();
  return indexerPromise;
}

export async function closeIndexer() {
  if (!indexerPromise) return;
  const { dbManager } = await indexerPromise;
  dbManager.close();
  indexerPromise = undefined;
}

/**
 * Write messages of one session into sessions.db. Message ids must be stable
 * per message so re-indexing is a no-op.
 * @returns number of messages newly written
 */
export async function indexMessages({ sessionId, cwd, startedAt, messages }) {
  if (messages.length === 0) return 0;
  const { dbManager, indexSession } = await getIndexer();
  const result = indexSession(dbManager, {
    id: sessionId,
    // Same derivation Pi uses for its own sessions, so project filters match.
    project: cwd.split("/").pop() ?? cwd,
    cwd,
    startedAt,
    endedAt: null,
    messages,
  });
  return result.messagesIndexed;
}

/**
 * Index transcript lines [fromLine, toLine) of one conversation. Message ids are
 * derived from line numbers, so re-indexing the same lines is a no-op.
 * @returns number of messages newly written
 */
export async function indexTranscriptLines({ conversationId, cwd, file, lines, fromLine = 0, startedAt, timestamp }) {
  const messages = [];
  for (let i = fromLine; i < lines.length; i++) {
    const parsed = parseTranscriptLine(lines[i]);
    if (!parsed?.text) continue;
    messages.push({
      id: `${sessionIdFor(conversationId)}-${i}`,
      role: parsed.role,
      content: parsed.text,
      timestamp,
      toolCalls: parsed.role === "assistant" && parsed.toolNames.length ? parsed.toolNames : undefined,
    });
  }
  if (messages.length === 0) return 0;

  let started = startedAt;
  if (!started) {
    try {
      const stat = fs.statSync(file);
      started = new Date(stat.birthtimeMs || stat.mtimeMs).toISOString();
    } catch {
      started = timestamp;
    }
  }
  return indexMessages({ sessionId: sessionIdFor(conversationId), cwd, startedAt: started, messages });
}
