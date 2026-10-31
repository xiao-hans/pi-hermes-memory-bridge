// Filter retries for pi-hermes-memory's own searchMemories().
// Category is stored only on failure entries (memory-tool.ts syncAddToSqlite).
// Project memories and user entries keep category null, so a category filter
// hides them even though the FTS query would match. Project is the directory
// basename; a global entry has project null.
//
// `project` and `target`, when the caller passes them explicitly, are identity
// filters: they say which memories the caller is allowed to see, not just a
// ranking hint. An empty result under those filters must stay empty rather
// than fall back across targets/projects, or callers get memories that don't
// belong to the project/target they asked for. Only `category` is loosened on
// an empty result, to work around the compat gap described above.

export function searchAttempts(params) {
  const attempts = [];
  const seen = new Set();
  const add = (next) => {
    const key = JSON.stringify(next);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(next);
  };

  const query = params.query;
  const project = params.project || undefined;
  const target = params.target;
  const limit = params.limit;
  add({ query, project, target, category: params.category, limit });
  if (params.category) add({ query, project, target, limit });
  return attempts;
}

// A result counts as a hit via the structured count when the tool provides
// one, else by sniffing the rendered text (pi-hermes-memory's memory_search
// replies "No memories found..." or "Found N ...").
export function hitCount(result) {
  if (typeof result?.details?.count === "number") return result.details.count;
  const text = result?.content?.find((part) => part?.type === "text")?.text ?? "";
  return text.startsWith("No memories found") ? 0 : text.startsWith("Found ") ? 1 : 0;
}

/**
 * Run `execute` over searchAttempts(params) in order, stopping at the first
 * hit. Returns the last (possibly empty) result if nothing hit.
 */
export async function runLooseSearch(params, execute) {
  let last;
  for (const attempt of searchAttempts(params)) {
    last = await execute(attempt);
    if (hitCount(last) > 0) return last;
  }
  return last;
}
