import assert from "node:assert/strict";
import test from "node:test";
import { deepMerge, matchesPathPattern, normalizeRelative, truncate } from "../scripts/lib/utils.mjs";

test("path policy matches exact, directory, and wildcard patterns", () => {
  assert.equal(matchesPathPattern(".env", ".env"), true);
  assert.equal(matchesPathPattern(".env.local", ".env.*"), true);
  assert.equal(matchesPathPattern(".git/config", ".git/"), true);
  assert.equal(matchesPathPattern("src/app.js", ".env.*"), false);
  assert.equal(normalizeRelative(".\\src\\app.js"), "src/app.js");
});

test("deepMerge preserves defaults and replaces arrays", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1] }, { a: { b: 3 }, list: [2] });
  assert.deepEqual(merged, { a: { b: 3, c: 2 }, list: [2] });
});

test("truncate keeps bounded context", () => {
  const output = truncate("x".repeat(100), 20);
  assert.ok(output.length < 100);
  assert.match(output, /truncated/);
});
