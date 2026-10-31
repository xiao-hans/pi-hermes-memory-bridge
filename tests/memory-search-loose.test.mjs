// Pure synthetic regression for the memory_search scope-leak fix: an explicit
// project/target filter must stay a hard filter on an empty result, and only
// `category` may be loosened on retry. No real pi-hermes-memory store or
// network is involved; `execute` below is a hand-written stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { searchAttempts, runLooseSearch } from "../memory-search-loose.mjs";

const empty = { details: { count: 0 }, content: [{ type: "text", text: "No memories found." }] };
const hit = (n = 1) => ({ details: { count: n }, content: [{ type: "text", text: `Found ${n}.` }] });

test("searchAttempts: explicit project+target+category never drops project/target", () => {
  const attempts = searchAttempts({ query: "初版", project: "proj-a", target: "project", category: "failure" });
  assert.equal(attempts.length, 2, "only the category-drop retry is allowed");
  for (const attempt of attempts) {
    assert.equal(attempt.project, "proj-a");
    assert.equal(attempt.target, "project");
  }
  assert.equal(attempts[0].category, "failure");
  assert.equal(attempts[1].category, undefined, "second attempt drops only category");
});

test("searchAttempts: explicit project+target without category has a single, unloosened attempt", () => {
  const attempts = searchAttempts({ query: "初版", project: "proj-a", target: "project" });
  assert.deepEqual(attempts, [{ query: "初版", project: "proj-a", target: "project", category: undefined, limit: undefined }]);
});

test("searchAttempts: no project/target supplied behaves as plain global search", () => {
  const attempts = searchAttempts({ query: "初版" });
  assert.deepEqual(attempts, [{ query: "初版", project: undefined, target: undefined, category: undefined, limit: undefined }]);
});

test("runLooseSearch: explicit project+target empty result does not fall back cross-scope", async () => {
  const calls = [];
  // A leaking implementation would retry without project/target and this
  // stand-in would then return a hit from an unrelated scope; the fixed
  // attempts list must never produce such a call.
  const execute = async (attempt) => {
    calls.push(attempt);
    return attempt.project && attempt.target ? empty : hit(8);
  };
  const result = await runLooseSearch({ query: "初版", project: "claude-memory-write-e2e-20261031-224003", target: "project" }, execute);
  assert.equal(calls.length, 1, "no retry is attempted once project+target are both explicit and empty");
  assert.deepEqual(result, empty);
});

test("runLooseSearch: category retry still keeps the explicit project/target filter", async () => {
  const calls = [];
  const execute = async (attempt) => {
    calls.push(attempt);
    if (attempt.category) return empty; // exact match misses due to the category compat gap
    return attempt.project === "proj-a" && attempt.target === "project" ? hit(3) : hit(8); // leak sentinel
  };
  const result = await runLooseSearch(
    { query: "初版", project: "proj-a", target: "project", category: "failure" },
    execute,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(result, hit(3), "retry must have kept project/target, not leaked to the sentinel hit");
});

test("runLooseSearch: a hit on the first attempt stops immediately", async () => {
  const calls = [];
  const execute = async (attempt) => {
    calls.push(attempt);
    return hit(1);
  };
  const result = await runLooseSearch({ query: "初版", project: "proj-a", target: "project", category: "failure" }, execute);
  assert.equal(calls.length, 1, "category retry must not run once the exact attempt already hit");
  assert.deepEqual(result, hit(1));
});

test("runLooseSearch: unspecified filters search globally and return whatever comes back", async () => {
  const execute = async () => empty;
  const result = await runLooseSearch({ query: "初版" }, execute);
  assert.deepEqual(result, empty);
});
