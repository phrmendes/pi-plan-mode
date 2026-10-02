import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlanConfig, parseAllowedTools } from "./config.ts";

/** Writes a plan.json file in a fresh temp directory and returns its path. */
function planFile(contents: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "pi-plan-mode-config-")), "plan.json");
    writeFileSync(path, contents);
    return path;
}

test("parseAllowedTools keeps meaningful unique tool names", () => {
    assert.deepEqual(parseAllowedTools([" mcp__docs__* ", "", 42, "mcp__docs__*", "task"]), ["mcp__docs__*", "task"]);
});

test("parseAllowedTools rejects non-array values", () => {
    assert.deepEqual(parseAllowedTools("mcp__docs__*"), []);
    assert.deepEqual(parseAllowedTools({ 0: "task" }), []);
    assert.deepEqual(parseAllowedTools(undefined), []);
});

test("loadPlanConfig reads an allowlist", () => {
    const path = planFile(JSON.stringify({ allowedTools: ["mcp__docs__*", "task"] }));
    assert.deepEqual(loadPlanConfig(path), { allowedTools: ["mcp__docs__*", "task"], errors: [] });
});

test("loadPlanConfig treats a missing file and an absent allowlist as empty", () => {
    assert.deepEqual(loadPlanConfig(join(tmpdir(), "pi-plan-mode-missing", "plan.json")), {
        allowedTools: [],
        errors: [],
    });
    assert.deepEqual(loadPlanConfig(planFile("{}")), { allowedTools: [], errors: [] });
});

test("loadPlanConfig reports malformed JSON", () => {
    const config = loadPlanConfig(planFile("{ not json"));
    assert.deepEqual(config.allowedTools, []);
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0], /plan\.json: /);
});

test("loadPlanConfig reports a malformed allowedTools value", () => {
    const config = loadPlanConfig(planFile(JSON.stringify({ allowedTools: "mcp__docs__*" })));
    assert.deepEqual(config.allowedTools, []);
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0], /must be an array/);
});

test("loadPlanConfig treats an empty or blank file as no configuration", () => {
    assert.deepEqual(loadPlanConfig(planFile("")), { allowedTools: [], errors: [] });
    assert.deepEqual(loadPlanConfig(planFile("  \n")), { allowedTools: [], errors: [] });
});

test("a bare wildcard is dropped and reported", () => {
    assert.deepEqual(parseAllowedTools(["*", " * ", "task"]), ["task"]);
    const config = loadPlanConfig(planFile(JSON.stringify({ allowedTools: ["*", "task"] })));
    assert.deepEqual(config.allowedTools, ["task"]);
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0], /every tool/);
});
