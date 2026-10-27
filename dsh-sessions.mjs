// DeepSeek Harness session logs (~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd):
// a concatenation of independently decodable Zstandard frames, each holding
// complete JSONL lines. The writer may leave a torn final frame; only complete
// frames are read.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

export const DSH_SESSIONS_DIR = process.env.DSH_SESSIONS_DIR ?? path.join(os.homedir(), ".dsh", "sessions");
const LOG_NAMES = ["session.v4.jsonl.zstd", "session.v4.jsonl"];
const ZSTD_MAGIC = 0xfd2fb528;

/** Byte ranges of the complete frames in buffer (same layout rules as dsh-session-persistence-jsonl). */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    const descriptor = buffer.readUInt8(offset++);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    let complete = false;
    while (offset + 3 <= buffer.length) {
      const header = buffer.readUIntLE(offset, 3);
      offset += 3;
      const blockType = (header >>> 1) & 3;
      offset += blockType === 1 ? 1 : header >>> 3;
      if (offset > buffer.length) break;
      if (header & 1) { complete = true; break; }
    }
    if (complete && checksum) offset += 4;
    if (!complete || offset > buffer.length) break;
    frames.push({ start, end: offset });
  }
  return frames;
}

/** Complete JSONL lines of a session log; [] when the log is unreadable. */
export function readSessionLines(file) {
  let buffer;
  try { buffer = fs.readFileSync(file); } catch { return []; }
  let text = "";
  if (file.endsWith(".zstd")) {
    for (const { start, end } of scanZstdFrames(buffer)) {
      try { text += zlib.zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"); } catch { break; }
    }
  } else {
    text = buffer.toString("utf8");
  }
  const lines = text.split("\n");
  lines.pop();
  return lines;
}

export const dshSessionIdFor = (sessionId) => `dsh-${sessionId}`;

const textOf = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .filter((b) => b?.type === "text" && typeof b.text === "string")
  .map((b) => b.text)
  .join("\n")
  .trim();

/** The session header (first line), or null. */
export function parseDshHeader(line) {
  try {
    const row = JSON.parse(line);
    return row?.type === "session" ? row : null;
  } catch {
    return null;
  }
}

/**
 * One log line -> { seq, time, role, text, toolNames }, or null for non-message
 * events. Only messages the human typed count as user messages; reasoning
 * blocks are dropped.
 */
export function parseDshLine(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (row?.type === "user/message") {
    if (row.data?.source?.kind !== "user") return null;
    const text = textOf(row.data.content);
    return text ? { seq: row.seq, time: row.time, role: "user", text, toolNames: [] } : null;
  }
  if (row?.type === "assistant/message") {
    const blocks = Array.isArray(row.data?.message?.content) ? row.data.message.content : [];
    const text = textOf(blocks);
    const toolNames = blocks.filter((b) => b?.type === "tool-call").map((b) => b.name ?? "tool");
    return text || toolNames.length ? { seq: row.seq, time: row.time, role: "assistant", text, toolNames } : null;
  }
  return null;
}

/** Every session log; delegated subagent sessions are told apart by their header's delegationDepth. */
export function listDshSessions() {
  const out = [];
  if (!fs.existsSync(DSH_SESSIONS_DIR)) return out;
  for (const workspace of fs.readdirSync(DSH_SESSIONS_DIR)) {
    const root = path.join(DSH_SESSIONS_DIR, workspace);
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const name of LOG_NAMES) {
        const file = path.join(root, entry.name, name);
        if (fs.existsSync(file)) { out.push({ file, sessionId: entry.name, workspace }); break; }
      }
    }
  }
  return out;
}
