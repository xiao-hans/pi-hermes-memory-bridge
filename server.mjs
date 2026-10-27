// MCP bridge: exposes the installed pi-hermes-memory extension's tools to
// Cursor and DeepSeek Harness, so they read and write the same store with the
// extension's own locking, entry format, SQLite sync and consolidation.
//
// stdout is the MCP channel; anything the extension logs must go to stderr.
for (const level of ["log", "info", "debug"]) console[level] = (...args) => console.error(...args);

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createHost } from "./host.mjs";

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const rawCwd = argValue("--cwd") ?? process.env.HERMES_CWD;
const HAS_WORKSPACE = Boolean(rawCwd && !rawCwd.includes("${") && fs.existsSync(rawCwd));
const DEFAULT_CWD = HAS_WORKSPACE ? rawCwd : process.cwd();

// Clients without hooks (DeepSeek Harness) rely on the learner polling their
// session logs; keep it running for as long as this server is.
const LEARNER_PORT = Number(process.env.HERMES_LEARNER_PORT ?? 37791);
const LEARNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "learner.mjs");
function pingLearner() {
  const req = http.request({ host: "127.0.0.1", port: LEARNER_PORT, path: "/ping", method: "POST", timeout: 1500 }, (res) => res.resume());
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => {
    spawn(process.execPath, [LEARNER], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  });
  req.end();
}
if (process.argv.includes("--learner") && process.env.HERMES_LEARNER_DISABLED !== "1") {
  pingLearner();
  setInterval(pingLearner, 60_000).unref();
}

let host;
try {
  host = await createHost({ cwd: DEFAULT_CWD });
} catch (err) {
  console.error(`[hermes-bridge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { tools, emit, makeCtx, memoryPolicy } = host;

const policy = await memoryPolicy();
const instructions = [
  "This server is the user's shared long-term memory (same store as their Pi agent's pi-hermes-memory).",
  "Search it before answering questions about the user's preferences, environment, past decisions or earlier sessions; save durable facts, corrections and preferences with memory_add.",
  "Project-scoped tools default to the current workspace; pass `cwd` to target another project.",
  policy,
].filter(Boolean).join("\n\n");

const plainSchema = (schema) => {
  const json = JSON.parse(JSON.stringify(schema ?? { type: "object", properties: {} }));
  json.type ??= "object";
  json.properties ??= {};
  json.properties.cwd = {
    type: "string",
    description: HAS_WORKSPACE
      ? "Workspace directory used to resolve project memory. Defaults to the current workspace."
      : "Absolute path of your current working directory, used to resolve project memory. Always pass it.",
  };
  return json;
};

const server = new Server(
  { name: "hermes-memory", version: "0.2.0" },
  { capabilities: { tools: {} }, instructions },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...tools.values()].map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.label ?? tool.name,
    inputSchema: plainSchema(tool.parameters),
  })),
}));

let callSeq = 0;
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const tool = tools.get(request.params.name);
  if (!tool) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }] };
  }
  const { cwd, ...params } = request.params.arguments ?? {};
  const ctx = makeCtx(cwd && fs.existsSync(cwd) ? cwd : DEFAULT_CWD);
  try {
    const result = await tool.execute(`cursor-${++callSeq}`, params, extra?.signal, undefined, ctx);
    const content = (result?.content ?? [])
      .filter((part) => part?.type === "text")
      .map((part) => ({ type: "text", text: part.text }));
    return {
      isError: result?.details?.success === false,
      content: content.length ? content : [{ type: "text", text: JSON.stringify(result?.details ?? {}) }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  } catch (err) {
    console.error(`[hermes-bridge] shutdown: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
console.error(`[hermes-bridge] ready: ${tools.size} tools, cwd=${DEFAULT_CWD}`);
