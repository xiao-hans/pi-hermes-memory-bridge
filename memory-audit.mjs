// Attribution of memory writes made by the learner's child `pi -p` runs:
// snapshot the memory store when a child starts, diff when it ends. The store
// is shared with Pi, so a Pi session writing during the same window shows up
// in the diff too; piActive flags those windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EXT_DIR, MEMORY_DIR } from "./host.mjs";

const PROJECTS_MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "projects-memory");
const ENTRY_FILES = ["MEMORY.md", "USER.md", "failures.md"];

const normalize = (entry) => entry.replace(/<!--[\s\S]*?-->/g, "").trim();

function readEntries(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  return new Set(text.split(/^§\s*$/m).map(normalize).filter(Boolean));
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function skillFiles(skillsDir) {
  return subdirs(skillsDir).map((d) => path.join(d, "SKILL.md")).filter((f) => fs.existsSync(f));
}

export function snapshotMemory() {
  const entryFiles = ENTRY_FILES.map((name) => path.join(MEMORY_DIR, name));
  const skills = skillFiles(path.join(MEMORY_DIR, "skills"));
  for (const project of subdirs(PROJECTS_MEMORY_DIR)) {
    entryFiles.push(...ENTRY_FILES.map((name) => path.join(project, name)));
    skills.push(...skillFiles(path.join(project, "skills")));
  }
  const entries = new Map();
  for (const file of entryFiles) {
    const set = readEntries(file);
    if (set) entries.set(file, set);
  }
  const skillStamps = new Map();
  for (const file of skills) {
    try {
      const stat = fs.statSync(file);
      skillStamps.set(file, `${stat.size}:${Math.trunc(stat.mtimeMs)}`);
    } catch {}
  }
  return { entries, skills: skillStamps };
}

const display = (file) => {
  const rel = path.relative(path.dirname(MEMORY_DIR), file);
  return rel.startsWith("..") ? file : rel.split(path.sep).join("/");
};

/** @returns {{ file: string, change: string, text?: string }[]} */
export function diffMemory(before, after) {
  const changes = [];
  for (const [file, now] of after.entries) {
    const was = before.entries.get(file) ?? new Set();
    for (const entry of now) if (!was.has(entry)) changes.push({ file: display(file), change: "added", text: entry });
    for (const entry of was) if (!now.has(entry)) changes.push({ file: display(file), change: "removed", text: entry });
  }
  for (const [file, stamp] of after.skills) {
    const was = before.skills.get(file);
    if (was !== stamp) changes.push({ file: display(file), change: was ? "skill-updated" : "skill-created" });
  }
  for (const file of before.skills.keys()) {
    if (!after.skills.has(file)) changes.push({ file: display(file), change: "skill-deleted" });
  }
  return changes;
}

let Database;
function openDb(readonly) {
  Database ??= createRequire(path.join(EXT_DIR, "package.json"))("better-sqlite3");
  const db = new Database(path.join(MEMORY_DIR, "sessions.db"), { readonly, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Pi sessions (not Cursor or DeepSeek Harness ones) with messages indexed in [fromMs, toMs]. */
export function piSessionsActiveBetween(fromMs, toMs) {
  try {
    const db = openDb(true);
    try {
      return db.prepare(
        "select distinct session_id from messages where session_id not like 'cursor-%' and session_id not like 'dsh-%' and timestamp between ? and ?",
      ).all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).map((r) => r.session_id);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const REVIEW_HEADING = "--- Conversation to Review ---";

/**
 * What one review run saw: how many messages, and whether they were only the
 * new ones since the previous review or the whole conversation again.
 * @returns {{ messages: number, mode: "incremental" | "full" | "unknown" }}
 */
export function describeReview(prompt, reviewedBefore) {
  const body = prompt.slice(prompt.lastIndexOf(REVIEW_HEADING) + REVIEW_HEADING.length);
  const messages = (body.match(/\[(USER|ASSISTANT)\]:/g) ?? []).length;
  if (!messages) return { messages, mode: "unknown" };
  const marked = body.includes("The following messages were already reviewed");
  return { messages, mode: reviewedBefore === 0 || marked ? "incremental" : "full" };
}

/** Remember which messages each review already covered, so the next one can be told. */
export function markReviewed(sessionId, count) {
  const db = openDb(false);
  try {
    db.prepare(
      "insert into extension_metadata (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
    ).run(`bridge-reviewed:${sessionId}`, String(count));
  } finally {
    db.close();
  }
}

export function reviewedCount(sessionId) {
  const db = openDb(true);
  try {
    return Number(db.prepare("select value from extension_metadata where key = ?").get(`bridge-reviewed:${sessionId}`)?.value ?? 0);
  } finally {
    db.close();
  }
}
