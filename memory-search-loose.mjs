// Filter retries for pi-hermes-memory's own searchMemories().
// Category is stored only on failure entries (memory-tool.ts syncAddToSqlite).
// Project memories and user entries keep category null, so a category filter
// hides them even though the FTS query would match. Project is the directory
// basename; a global entry has project null.

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
  const limit = params.limit;
  add({ query, project, target: params.target, category: params.category, limit });
  if (params.category) add({ query, project, target: params.target, limit });
  if (params.target && params.target !== "memory") add({ query, project, limit });
  if (project) add({ query, limit });
  return attempts;
}
