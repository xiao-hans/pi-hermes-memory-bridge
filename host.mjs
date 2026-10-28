// Minimal Pi host for the installed pi-hermes-memory extension. Each call to
// createHost() is one extension instance, equivalent to one Pi session.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { searchAttempts } from "./memory-search-loose.mjs";

const HOME = os.homedir();

export const EXT_DIR = process.env.HERMES_EXT_DIR
  ?? path.join(HOME, ".pi", "agent", "npm", "node_modules", "pi-hermes-memory");

function findPiPackage() {
  const rel = path.join("node_modules", "@earendil-works", "pi-coding-agent");
  const dirs = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter),
    process.env.APPDATA && path.join(process.env.APPDATA, "npm"),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/^"|"$/g, ""), rel);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return path.join(path.dirname(process.execPath), rel);
}

export const PI_PKG = process.env.PI_PKG_DIR ?? findPiPackage();

export const MEMORY_DIR = process.env.HERMES_MEMORY_DIR
  ?? path.join(HOME, ".pi", "agent", "pi-hermes-memory");

export function assertInstalled() {
  for (const [label, dir] of [["pi-hermes-memory", EXT_DIR], ["pi-coding-agent", PI_PKG]]) {
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      throw new Error(`${label} not found at ${dir}`);
    }
  }
}

function piAliases() {
  const req = createRequire(path.join(PI_PKG, "package.json"));
  const dep = (name, rel) => path.join(PI_PKG, "node_modules", "@earendil-works", name, rel);
  const codingAgent = path.join(PI_PKG, "dist", "index.js");
  const agentCore = dep("pi-agent-core", "dist/index.js");
  const tui = dep("pi-tui", "dist/index.js");
  const aiCompat = dep("pi-ai", "dist/compat.js");
  const aiOauth = dep("pi-ai", "dist/oauth.js");
  const aiProviders = dep("pi-ai", "dist/providers/all.js");
  const typebox = req.resolve("typebox");
  const typeboxCompile = req.resolve("typebox/compile");
  const typeboxValue = req.resolve("typebox/value");
  const aliases = {};
  for (const scope of ["@earendil-works", "@mariozechner"]) {
    Object.assign(aliases, {
      [`${scope}/pi-coding-agent`]: codingAgent,
      [`${scope}/pi-agent-core`]: agentCore,
      [`${scope}/pi-tui`]: tui,
      [`${scope}/pi-ai/providers/all`]: aiProviders,
      [`${scope}/pi-ai/compat`]: aiCompat,
      [`${scope}/pi-ai/oauth`]: aiOauth,
      [`${scope}/pi-ai`]: aiCompat,
    });
  }
  return Object.assign(aliases, {
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
  });
}

let jitiPromise;
function getJiti() {
  jitiPromise ??= (async () => {
    assertInstalled();
    const { createJiti } = await import(
      pathToFileURL(path.join(PI_PKG, "node_modules", "jiti", "lib", "jiti.mjs")).href
    );
    return createJiti(import.meta.url, { alias: piAliases() });
  })();
  return jitiPromise;
}

/** Import a module from the installed extension, e.g. "src/store/db.ts". */
export async function importExtensionModule(relPath, options) {
  const jiti = await getJiti();
  return jiti.import(path.join(EXT_DIR, ...relPath.split("/")), options);
}

const loadExtensionFactory = () => importExtensionModule("src/index.ts", { default: true });

function runProcess(command, args, options = {}, defaultCwd, onSettled = (_code) => {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? defaultCwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = options.timeout
      ? setTimeout(() => { killed = true; child.kill(); }, options.timeout)
      : null;
    const onAbort = () => { killed = true; child.kill(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      onSettled(code ?? 1);
      resolve({ stdout, stderr, code: code ?? 1, killed });
    };
    child.on("error", (err) => { stderr += String(err); finish(1); });
    child.on("close", finish);
  });
}

/**
 * @param {{
 *   cwd: string,
 *   getBranch?: () => unknown[],
 *   log?: (msg: string) => void,
 *   onChildStart?: (command: string, args: string[]) => ((code: number) => void) | void,
 * }} options
 */
export async function createHost({ cwd, getBranch = () => [], log = (msg) => console.error(msg), onChildStart }) {
  const extension = await loadExtensionFactory();
  const handlers = new Map();
  const tools = new Map();
  let runningChildren = 0;
  let lastChildStartedAt = 0;

  const ui = {
    notify: (message, level) => log(`[hermes-memory${level ? `:${level}` : ""}] ${message}`),
    setStatus() {},
    setWidget() {},
  };

  const makeCtx = (ctxCwd = cwd) => ({
    cwd: ctxCwd,
    hasUI: false,
    ui,
    sessionManager: {
      getSessionFile: () => undefined,
      getEntries: () => getBranch(),
      getBranch: () => getBranch(),
    },
  });

  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    registerShortcut() {},
    registerFlag() {},
    getFlag() { return undefined; },
    registerMessageRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},
    exec: (command, args, options) => {
      runningChildren++;
      lastChildStartedAt = Date.now();
      let onChildEnd;
      try { onChildEnd = onChildStart?.(command, args); } catch (err) { log(`onChildStart failed: ${err}`); }
      return runProcess(command, args, options, cwd, (code) => {
        runningChildren--;
        try { onChildEnd?.(code); } catch (err) { log(`onChildEnd failed: ${err}`); }
      });
    },
    events: { on() {}, emit() {} },
  };

  extension(pi);

  const searchTool = tools.get("memory_search");
  if (searchTool?.execute) {
    const inner = searchTool.execute.bind(searchTool);
    const hitCount = (result) => {
      if (typeof result?.details?.count === "number") return result.details.count;
      const text = result?.content?.find((part) => part?.type === "text")?.text ?? "";
      return text.startsWith("No memories found") ? 0 : text.startsWith("Found ") ? 1 : 0;
    };
    searchTool.execute = async (id, params, ...rest) => {
      let last;
      for (const attempt of searchAttempts(params ?? {})) {
        last = await inner(id, attempt, ...rest);
        if (hitCount(last) > 0) return last;
      }
      return last;
    };
  }

  async function emit(event, payload, ctx = makeCtx()) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function memoryPolicy() {
    const results = await emit("before_agent_start", { type: "before_agent_start", prompt: "", systemPrompt: "" });
    return results
      .map((r) => (r && typeof r.systemPrompt === "string" ? r.systemPrompt.trim() : ""))
      .filter(Boolean)
      .join("\n\n");
  }

  await emit("session_start", { type: "session_start", reason: "startup" });

  return {
    tools,
    emit,
    makeCtx,
    memoryPolicy,
    runningChildren: () => runningChildren,
    lastChildStartedAt: () => lastChildStartedAt,
  };
}
