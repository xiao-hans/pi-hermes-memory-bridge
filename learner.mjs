// Background learner: replays Cursor conversations into one pi-hermes-memory
// extension instance per conversation, so the extension's own background
// review, correction detection and end-of-conversation flush run on Cursor
// chats as they do on Pi sessions.
//
// The conversation transcript (transcript_path, sent with every hook) is the
// source of truth: any hook triggers a sync of the lines appended since the
// last sync. Hook-provided prompt/response text is only used when the
// transcript is unavailable.
//
// DeepSeek Harness has no hooks: its session logs under ~/.dsh/sessions are
// polled instead and fed through the same per-conversation instances.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost } from "./host.mjs";
import { describeReview, diffMemory, markReviewed, piSessionsActiveBetween, reviewedCount, snapshotMemory } from "./memory-audit.mjs";
import { polledAgents, readTextLines } from "./agent-logs.mjs";
import { dshSessionIdFor, listDshSessions, parseDshHeader, parseDshLine, readSessionLines } from "./dsh-sessions.mjs";
import {
  cleanUserText,
  decodeProjectDir,
  indexMessages,
  indexTranscriptLines,
  listTranscripts,
  parseTranscriptLine,
  readCompleteLines,
} from "./sessions.mjs";

const BRIDGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.HERMES_LEARNER_PORT ?? 37791);
const CONVERSATION_IDLE_MS = Number(process.env.HERMES_CONVERSATION_IDLE_MS ?? 30 * 60_000);
const PROCESS_IDLE_MS = Number(process.env.HERMES_LEARNER_IDLE_MS ?? 10 * 60_000);
const CHILD_WAIT_MS = 180_000;
const MIN_UNREVIEWED_FOR_FLUSH = 2;
// The extension reviews only after 3 user messages and flushes only after 6
// (its defaults). Pi sessions pass that naturally; a DSH task is often one
// request followed by a long tool run, so it never starts. Once a DSH
// session has a real user message, report the threshold with empty messages
// that are not part of the conversation, and the extension's own cadence
// (10 turns or 15 tool calls) takes over.
const DSH_USER_TURN_GATE = 6;
const DSH_POLL_MS = Number(process.env.HERMES_DSH_POLL_MS ?? 10_000);
const DSH_ENABLED = process.env.HERMES_DSH_DISABLED !== "1";
const learnerStartedAt = Date.now();

const LOG_DIR = path.join(BRIDGE_DIR, "logs");
const STATE_DIR = path.join(BRIDGE_DIR, "state");
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "learner.log");
const LEARNED_FILE = path.join(LOG_DIR, "learned.jsonl");
const log = (msg) => {
  try {
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};
for (const level of ["log", "info", "debug", "warn", "error"]) {
  console[level] = (...args) => log(`[${level}] ${args.map(String).join(" ")}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (err) => (err instanceof Error ? err.stack ?? err.message : String(err));

const statePath = (id) => path.join(STATE_DIR, `${id.replace(/[^\w.-]/g, "_")}.json`);
const loadCursor = (id) => {
  try {
    return JSON.parse(fs.readFileSync(statePath(id), "utf8")).lines ?? 0;
  } catch {
    return 0;
  }
};
const saveCursor = (id, lines) => {
  try {
    fs.writeFileSync(statePath(id), JSON.stringify({ lines, updated: new Date().toISOString() }));
  } catch {}
};

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const INDEX_STATE = path.join(STATE_DIR, "index.json");
const PROJECTS_STATE = path.join(STATE_DIR, "projects.json");
const DSH_STATE = path.join(STATE_DIR, "dsh.json");
const AGENTS_STATE = path.join(STATE_DIR, "agents.json");
const indexState = readJson(INDEX_STATE, {});
const projectCwds = readJson(PROJECTS_STATE, {});
const dshSynced = readJson(DSH_STATE, {});
const agentSynced = readJson(AGENTS_STATE, {});
const saveDshState = () => { try { fs.writeFileSync(DSH_STATE, JSON.stringify(dshSynced, null, 1)); } catch {} };
const saveAgentState = () => { try { fs.writeFileSync(AGENTS_STATE, JSON.stringify(agentSynced, null, 1)); } catch {} };
const saveIndexState = () => { try { fs.writeFileSync(INDEX_STATE, JSON.stringify(indexState, null, 1)); } catch {} };
const saveProjectCwds = () => { try { fs.writeFileSync(PROJECTS_STATE, JSON.stringify(projectCwds, null, 1)); } catch {} };

/** ~/.cursor/projects/<projectDir>/agent-transcripts/... -> <projectDir> */
const projectDirOf = (transcript) => path.basename(path.dirname(path.dirname(path.dirname(transcript))));

function markIndexed(file) {
  try {
    const stat = fs.statSync(file);
    indexState[file] = { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
    saveIndexState();
  } catch {}
}

function textMessage(role, text, toolCalls = 0) {
  const content = [];
  if (text) content.push({ type: "text", text });
  for (let i = 0; i < toolCalls; i++) {
    content.push({ type: "toolCall", id: `cursor-tool-${i}`, name: "cursor", arguments: {} });
  }
  return { role, content, timestamp: Date.now() };
}

/** Convert one transcript line into a Pi-style message, or null to skip. */
function transcriptMessage(line) {
  const parsed = parseTranscriptLine(line);
  if (!parsed || (parsed.role === "user" && !parsed.text)) return null;
  return textMessage(parsed.role, parsed.text, parsed.role === "assistant" ? parsed.toolNames.length : 0);
}

let activeChildren = 0;

const REVIEW_NOTE = "The following messages were already reviewed; do not save facts from them again:";

/**
 * Record what each child `pi -p` run changed in the shared memory store, and
 * steer the next review: the review prompt otherwise contains the whole
 * conversation every time, which is why the same fact gets saved repeatedly.
 */
function auditChild(conv) {
  const startedAt = Date.now();
  const kind = conv.childKind;
  const before = snapshotMemory();
  const overlapping = activeChildren++ > 0;
  let review;
  try {
    const prompt = conv.lastChildArgs?.at(-1);
    if (typeof prompt === "string" && prompt.includes("--- Conversation to Review ---")) {
      review = describeReview(prompt, reviewedCount(conv.id));
      if (review.mode === "incremental") markReviewed(conv.id, conv.entries.length);
    }
  } catch (err) {
    log(`${shortId(conv.id)} review bookkeeping failed: ${errText(err)}`);
  }
  return (code) => {
    activeChildren--;
    const changes = diffMemory(before, snapshotMemory());
    if (changes.length === 0) return;
    const endedAt = Date.now();
    const piSessions = piSessionsActiveBetween(startedAt - 120_000, endedAt);
    const record = {
      time: new Date(endedAt).toISOString(),
      conversation: conv.id,
      cwd: conv.cwd,
      kind,
      exitCode: code,
      durationMs: endedAt - startedAt,
      overlapping,
      piSessions,
      review,
      changes,
    };
    try { fs.appendFileSync(LEARNED_FILE, `${JSON.stringify(record)}\n`); } catch {}
    const counts = {};
    for (const c of changes) counts[`${c.change} ${c.file}`] = (counts[`${c.change} ${c.file}`] ?? 0) + 1;
    const summary = Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(", ");
    const caveats = [overlapping && "overlapping child", piSessions.length && `Pi active: ${piSessions.length} session(s)`].filter(Boolean);
    log(`${shortId(conv.id)} learned (${kind}): ${summary}${caveats.length ? ` [${caveats.join("; ")}]` : ""}`);
  };
}

/** @type {Map<string, any>} */
const conversations = new Map();
const chains = new Map();
const recentlyClosed = new Map();
let lastActivity = Date.now();

/** Short log tag: Cursor conversation ids, or "dsh-" plus the DSH session id. */
const shortId = (id) => {
  const prefixed = /^(dsh|codebuddy|workbuddy|codex)-/.exec(id);
  if (prefixed) return `${prefixed[1]}-${id.slice(prefixed[0].length).replace(/^session-/, "").slice(0, 8)}`;
  return id.slice(0, 8);
};

/** One extension instance for one conversation; contextMessages are history that is not learned again. */
async function createConversation({ id, cwd, transcript = null, contextMessages = [], cursor = 0 }) {
  const entries = contextMessages.map((message) => ({ type: "message", message }));
  const conv = {
    id,
    childKind: "review",
    entries,
    cwd,
    transcript,
    cursor,
    lastActive: Date.now(),
    userMessageTimes: [],
  };
  conv.host = await createHost({
    cwd,
    getBranch: () => {
      // Reviews re-read the whole conversation; mark what earlier reviews
      // already covered so the same facts are not saved again.
      const reviewed = conv.childKind === "review" ? reviewedCount(id) : 0;
      if (reviewed > 0 && reviewed < entries.length) {
        return [
          ...entries.slice(0, reviewed),
          { type: "message", message: textMessage("user", REVIEW_NOTE) },
          ...entries.slice(reviewed),
        ];
      }
      return entries;
    },
    log: (m) => log(`${shortId(id)} ${m}`),
    onChildStart: (command, args) => {
      conv.lastChildArgs = args;
      return auditChild(conv);
    },
  });
  log(`open ${id} cwd=${cwd} resumedAt=${cursor}`);
  return conv;
}

async function openConversation(id, payload) {
  const cwd = payload.workspace_roots?.find((root) => root && fs.existsSync(root)) ?? process.cwd();
  if (payload.transcript_path && payload.workspace_roots?.length) {
    const projectDir = projectDirOf(payload.transcript_path);
    if (projectCwds[projectDir] !== cwd) {
      projectCwds[projectDir] = cwd;
      saveProjectCwds();
    }
  }
  const transcript = payload.transcript_path ?? null;
  // A resumed conversation: earlier lines become context only, so they are not learned twice.
  const saved = loadCursor(id);
  const contextMessages = [];
  let cursor = 0;
  if (saved > 0 && transcript && fs.existsSync(transcript)) {
    const lines = readCompleteLines(transcript).slice(0, saved);
    for (const line of lines) {
      const message = transcriptMessage(line);
      if (message) contextMessages.push(message);
    }
    cursor = lines.length;
  }
  return createConversation({ id, cwd, transcript, contextMessages, cursor });
}

async function deliver(conv, message) {
  const ctx = conv.host.makeCtx(conv.cwd);
  if (message.role === "user") conv.userMessageTimes.push(Date.now());
  conv.entries.push({ type: "message", message });
  await conv.host.emit("message_end", { type: "message_end", message }, ctx);
  if (message.role === "assistant") {
    await conv.host.emit("turn_end", { type: "turn_end", turnIndex: conv.entries.length, message, toolResults: [] }, ctx);
  }
}

async function syncTranscript(conv) {
  if (!conv.transcript || !fs.existsSync(conv.transcript)) return false;
  const lines = readCompleteLines(conv.transcript);
  if (lines.length < conv.cursor) conv.cursor = 0;
  const fromLine = conv.cursor;
  let delivered = 0;
  for (const line of lines.slice(fromLine)) {
    const message = transcriptMessage(line);
    if (message) {
      await deliver(conv, message);
      delivered++;
    }
  }
  conv.cursor = lines.length;
  saveCursor(conv.id, conv.cursor);

  let indexed = 0;
  try {
    indexed = await indexTranscriptLines({
      conversationId: conv.id,
      cwd: conv.cwd,
      file: conv.transcript,
      lines,
      fromLine,
      timestamp: new Date().toISOString(),
    });
    markIndexed(conv.transcript);
  } catch (err) {
    log(`${shortId(conv.id)} session index failed: ${errText(err)}`);
  }
  if (delivered) log(`${shortId(conv.id)} synced ${delivered} messages, indexed ${indexed} (cursor=${conv.cursor})`);
  return true;
}

/** Let in-flight reviews (child `pi -p` runs) finish before flushing or shutting down. */
async function waitForChildren(conv) {
  const deadline = Date.now() + CHILD_WAIT_MS;
  let quietChecks = 0;
  while (Date.now() < deadline && quietChecks < 2) {
    await sleep(1500);
    quietChecks = conv.host.runningChildren() === 0 ? quietChecks + 1 : 0;
  }
}

async function closeConversation(id, reason) {
  const conv = conversations.get(id);
  if (!conv) return;
  conversations.delete(id);
  recentlyClosed.set(id, Date.now());
  const ctx = conv.host.makeCtx(conv.cwd);
  let flushed = false;
  try {
    await waitForChildren(conv);
    // Skip the flush when a background review already covered nearly all of the
    // conversation; otherwise both save the same facts.
    const reviewStartedAt = conv.host.lastChildStartedAt();
    const unreviewedUserMessages = conv.userMessageTimes.filter((t) => t >= reviewStartedAt).length;
    if (unreviewedUserMessages >= MIN_UNREVIEWED_FOR_FLUSH) {
      flushed = true;
      conv.childKind = "flush";
      // The pre-compaction flush gets a 60s budget; the shutdown flush only 10s,
      // too short for a child `pi -p`, so shutdown is emitted as a reload.
      await conv.host.emit("session_before_compact", { type: "session_before_compact" }, ctx);
      await waitForChildren(conv);
    }
    await conv.host.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
  } catch (err) {
    log(`close ${id} failed: ${errText(err)}`);
  }
  log(`close ${id} (${reason}), ${conv.entries.length} messages, flush=${flushed ? "ran" : "skipped"}`);
}

async function handleEvent(event, payload) {
  const id = payload.conversation_id ?? payload.session_id;
  if (!id) return;

  let conv = conversations.get(id);
  if (!conv) {
    const closedAt = recentlyClosed.get(id);
    if (event === "sessionEnd" && closedAt && Date.now() - closedAt < 120_000) return;
    if (!payload.transcript_path && event !== "beforeSubmitPrompt") return;
    conv = await openConversation(id, payload);
    conversations.set(id, conv);
  }
  conv.lastActive = Date.now();
  conv.transcript ??= payload.transcript_path ?? null;

  const synced = await syncTranscript(conv);
  if (!synced) {
    if (event === "beforeSubmitPrompt" && payload.prompt) {
      await deliver(conv, textMessage("user", cleanUserText(payload.prompt)));
    } else if (event === "afterAgentResponse" && payload.text) {
      await deliver(conv, textMessage("assistant", payload.text));
    }
  }

  if (event === "preCompact") {
    conv.childKind = "compact";
    try {
      await conv.host.emit("session_before_compact", { type: "session_before_compact" }, conv.host.makeCtx(conv.cwd));
    } finally {
      conv.childKind = "review";
    }
  } else if (event === "sessionEnd") {
    await closeConversation(id, payload.reason ?? "sessionEnd");
  }
}

/** Run task after everything already queued for the same conversation. */
function enqueueTask(id, label, task) {
  const next = (chains.get(id) ?? Promise.resolve())
    .then(task)
    .catch((err) => log(`${label} failed: ${errText(err)}`));
  chains.set(id, next);
  next.finally(() => { if (chains.get(id) === next) chains.delete(id); });
}

function enqueue(event, payload) {
  lastActivity = Date.now();
  const id = payload.conversation_id ?? payload.session_id ?? "_";
  enqueueTask(id, event, () => handleEvent(event, payload));
}

function dshMessage(parsed) {
  return { ...textMessage(parsed.role, parsed.text, parsed.toolNames.length), timestamp: parsed.time ?? Date.now() };
}

async function indexConversationLines(id, cwd, header, lines, fromLine, parseLine) {
  const messages = [];
  for (let i = fromLine; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i);
    if (!parsed?.text) continue;
    const time = typeof parsed.time === "number" ? parsed.time : Date.parse(parsed.time);
    messages.push({
      id: `${id}-${parsed.seq}`,
      role: parsed.role,
      content: parsed.text,
      timestamp: new Date(Number.isNaN(time) ? Date.now() : time).toISOString(),
      toolCalls: parsed.toolNames.length ? parsed.toolNames : undefined,
    });
  }
  const started = typeof header.createdAt === "number" ? header.createdAt : Date.parse(header.createdAt);
  return indexMessages({
    sessionId: id,
    cwd,
    startedAt: new Date(Number.isNaN(started) ? Date.now() : started).toISOString(),
    messages,
  });
}

const createdAtMs = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? Date.now() : ms;
};

/**
 * Replay one polled session log through its extension instance.
 * A log that already existed when this process started is indexed once and
 * not reviewed; lines appended after that are learned.
 */
async function syncLog({ id, file, stamp, synced, saveSynced, readLines, parseHeader, parseLine }) {
  const lines = readLines(file);
  const header = parseHeader(lines);
  if (!header || (header.delegationDepth ?? 0) > 0) {
    synced[file] = stamp;
    return;
  }
  const cwd = header.cwd && fs.existsSync(header.cwd) ? header.cwd : os.homedir();

  let conv = conversations.get(id);
  if (!conv) {
    let saved = loadCursor(id);
    if (saved === 0 && createdAtMs(header.createdAt) < learnerStartedAt - DSH_POLL_MS) {
      const indexed = await indexConversationLines(id, cwd, header, lines, 0, parseLine);
      saved = lines.length;
      saveCursor(id, saved);
      if (indexed) log(`${shortId(id)} indexed ${indexed} earlier messages (not reviewed)`);
    }
    if (lines.length <= saved) {
      synced[file] = stamp;
      saveSynced();
      return;
    }
    const contextMessages = [];
    for (let i = 0; i < saved; i++) {
      const parsed = parseLine(lines[i], i);
      if (parsed) contextMessages.push(dshMessage(parsed));
    }
    conv = await createConversation({ id, cwd, contextMessages, cursor: saved });
    conversations.set(id, conv);
  }
  if (lines.length < conv.cursor) conv.cursor = lines.length;

  const fromLine = conv.cursor;
  let delivered = 0;
  for (let i = fromLine; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i);
    if (!parsed) continue;
    await deliver(conv, dshMessage(parsed));
    delivered++;
  }
  conv.cursor = lines.length;
  conv.lastActive = Date.now();
  lastActivity = Date.now();
  saveCursor(id, conv.cursor);
  await openDshTurnGate(conv);

  let indexed = 0;
  try {
    indexed = await indexConversationLines(id, conv.cwd, header, lines, fromLine, parseLine);
  } catch (err) {
    log(`${shortId(id)} session index failed: ${errText(err)}`);
  }
  synced[file] = stamp;
  saveSynced();
  if (delivered) log(`${shortId(id)} synced ${delivered} messages, indexed ${indexed} (cursor=${conv.cursor})`);
}

async function syncDshSession(id, file, stamp) {
  return syncLog({
    id, file, stamp, synced: dshSynced, saveSynced: saveDshState,
    readLines: readSessionLines, parseHeader: (lines) => (lines.length ? parseDshHeader(lines[0]) : null), parseLine: (line) => parseDshLine(line),
  });
}
async function openDshTurnGate(conv) {
  if (conv.turnGateOpen) return;
  const hasUser = conv.entries.some((entry) => entry.message?.role === "user");
  if (!hasUser) return;
  conv.turnGateOpen = true;
  const ctx = conv.host.makeCtx(conv.cwd);
  const message = { role: "user", content: [], timestamp: Date.now() };
  for (let i = 0; i < DSH_USER_TURN_GATE; i++) {
    await conv.host.emit("message_end", { type: "message_end", message }, ctx);
  }
  log(`${shortId(conv.id)} review gate open`);
}


const dshQueued = new Map();
const agentQueued = new Map();

function pollFiles(list, queued, synced, label, idFor, sync) {
  for (const { file, sessionId } of list()) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const stamp = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    if (synced[file] === stamp || queued.get(file) === stamp) continue;
    queued.set(file, stamp);
    const id = idFor(sessionId);
    enqueueTask(id, `${label} sync ${sessionId}`, () => sync(id, file, stamp).catch((err) => {
      queued.delete(file);
      throw err;
    }));
  }
}

function pollDsh() {
  pollFiles(listDshSessions, dshQueued, dshSynced, "dsh", dshSessionIdFor, syncDshSession);
}

function pollAgents() {
  for (const agent of polledAgents) {
    pollFiles(
      agent.list,
      agentQueued,
      agentSynced,
      agent.name,
      (sessionId) => `${agent.name}-${sessionId}`,
      (id, file, stamp) => syncLog({
        id, file, stamp, synced: agentSynced, saveSynced: saveAgentState,
        readLines: readTextLines, parseHeader: agent.parseHeader, parseLine: agent.parseLine,
      }),
    );
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify({ ok: true, conversations: conversations.size }));
    return;
  }
  if (req.method === "POST" && req.url === "/ping") {
    lastActivity = Date.now();
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/event") {
    res.statusCode = 404;
    res.end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.statusCode = 202;
    res.end();
    try {
      const { event, payload } = JSON.parse(body);
      if (event && payload) enqueue(event, payload);
    } catch (err) {
      log(`bad event: ${errText(err)}`);
    }
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") process.exit(0);
  log(`server error: ${err.message}`);
  process.exit(1);
});

/** Index Cursor transcripts that changed since they were last indexed (missed hooks, older chats). */
async function backfillSessions() {
  let files = 0;
  let messages = 0;
  for (const { file, conversationId, projectDir } of listTranscripts()) {
    if (conversations.has(conversationId)) continue;
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const known = indexState[file];
    if (known && known.size === stat.size && known.mtimeMs === Math.trunc(stat.mtimeMs)) continue;
    const cwd = projectCwds[projectDir] ?? decodeProjectDir(projectDir) ?? projectDir;
    try {
      messages += await indexTranscriptLines({
        conversationId,
        cwd,
        file,
        lines: readCompleteLines(file),
        timestamp: new Date(stat.mtimeMs).toISOString(),
      });
      markIndexed(file);
      files++;
    } catch (err) {
      log(`backfill ${conversationId} failed: ${errText(err)}`);
    }
  }
  log(`backfill: ${files} transcripts updated, ${messages} messages indexed`);
}

server.listen(PORT, "127.0.0.1", () => {
  log(`learner listening on ${PORT} (pid ${process.pid})`);
  const run = () => backfillSessions().catch((err) => log(`backfill failed: ${errText(err)}`));
  chains.set("_backfill", (chains.get("_backfill") ?? Promise.resolve()).then(run).finally(() => chains.delete("_backfill")));
  if (DSH_ENABLED) {
    const poll = () => {
      try { pollDsh(); } catch (err) { log(`dsh poll failed: ${errText(err)}`); }
      try { pollAgents(); } catch (err) { log(`agent poll failed: ${errText(err)}`); }
    };
    poll();
    setInterval(poll, DSH_POLL_MS);
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastActive > CONVERSATION_IDLE_MS) enqueue("sessionEnd", { conversation_id: id, reason: "idle", transcript_path: conv.transcript });
  }
  for (const [id, at] of recentlyClosed) {
    if (now - at > 300_000) recentlyClosed.delete(id);
  }
  if (conversations.size === 0 && chains.size === 0 && now - lastActivity > PROCESS_IDLE_MS) {
    log("idle, exiting");
    process.exit(0);
  }
}, 60_000);

async function shutdownAll() {
  await Promise.allSettled([...conversations.keys()].map((id) => closeConversation(id, "learner-exit")));
  process.exit(0);
}
process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);
