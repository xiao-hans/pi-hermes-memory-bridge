// Retries an empty pi-hermes-memory memory_search with looser filters. The
// extension stores category only on failure entries, and some providers force
// the model to fill every optional filter, so strict calls miss real entries.
// Pi rejects duplicate tool names, so this rewrites the result instead.
// Imports are dynamic so an extension update that moves these files only
// disables the retry instead of stopping Pi from starting.
import os from "node:os";
import path from "node:path";

const EXT_SRC = "../npm/node_modules/pi-hermes-memory/src";
const MEMORY_DIR = path.join(os.homedir(), ".pi", "agent", "pi-hermes-memory");

export default async function (pi: any) {
  let search: any;
  try {
    const [{ DatabaseManager }, { registerMemorySearchTool }] = await Promise.all([
      import(`${EXT_SRC}/store/db.js`),
      import(`${EXT_SRC}/tools/memory-search-tool.js`),
    ]);
    registerMemorySearchTool({ registerTool: (tool: any) => { search = tool; } }, new DatabaseManager(MEMORY_DIR));
  } catch (err) {
    console.warn(`[pi-memory-search] retry disabled: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  pi.on("tool_result", async (event: any) => {
    if (event.toolName !== "memory_search" || event.isError || event.details?.count !== 0) return;
    for (const attempt of looserAttempts(event.input ?? {})) {
      const result = await search.execute(event.toolCallId, attempt);
      if (result?.details?.count > 0) return { content: result.content, details: result.details };
    }
  });
}

// Same order as the bridge's memory-search-loose.mjs, ending with query only.
function looserAttempts(input: any) {
  const { query, target, category, limit } = input;
  const project = input.project || undefined;
  const candidates = [
    { query, project, target, limit },
    { query, project, limit },
    { query, limit },
  ];
  const seen = new Set([JSON.stringify({ query, project: input.project, target, category, limit })]);
  return candidates.filter((attempt) => {
    const key = JSON.stringify(attempt);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
