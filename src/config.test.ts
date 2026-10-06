import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyModes, loadPlanConfig, splitModelRef } from "./config.ts";

/** Writes a plan.json file in a fresh temp directory and returns its path. */
function planFile(contents: unknown): string {
    const path = join(mkdtempSync(join(tmpdir(), "pi-plan-mode-config-")), "plan.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    return path;
}

const MODEL_REFS: Array<{ name: string; ref: string; expected: { provider: string; id: string } | undefined }> = [
    { name: "plain id", ref: "deepseek/deepseek-flash", expected: { provider: "deepseek", id: "deepseek-flash" } },
    {
        name: "id that contains a slash",
        ref: "bifrost-openai/Huawei/deepseek-v4-pro",
        expected: { provider: "bifrost-openai", id: "Huawei/deepseek-v4-pro" },
    },
    {
        name: "surrounding spaces",
        ref: " deepseek / deepseek-flash ",
        expected: { provider: "deepseek", id: "deepseek-flash" },
    },
    { name: "no provider separator", ref: "deepseek-flash", expected: undefined },
    { name: "empty provider", ref: "/deepseek-flash", expected: undefined },
    { name: "empty id", ref: "deepseek/", expected: undefined },
    { name: "empty value", ref: "", expected: undefined },
];

for (const { name, ref, expected } of MODEL_REFS) {
    test(`splitModelRef: ${name}`, () => {
        assert.deepEqual(splitModelRef(ref), expected);
    });
}

test("loadPlanConfig reads the models and the deny list of each mode", () => {
    const path = planFile({
        modes: {
            brainstorming: {
                model: "bifrost-anthropic/claude-opus-5-5",
                deniedTools: [" mcp__k8s__* ", "", 42, "mcp__k8s__*"],
            },
            thinking: { model: "bifrost-anthropic/claude-opus-5-5" },
            implementing: { model: " bifrost-openai/Huawei/deepseek-v4-pro " },
        },
    });
    assert.deepEqual(loadPlanConfig(path), {
        modes: {
            brainstorming: { model: "bifrost-anthropic/claude-opus-5-5", deniedTools: ["mcp__k8s__*"] },
            implementing: { model: "bifrost-openai/Huawei/deepseek-v4-pro" },
            thinking: { model: "bifrost-anthropic/claude-opus-5-5" },
        },
        errors: [],
    });
});

const EMPTY_CONFIGS: Array<{ name: string; path: () => string }> = [
    { name: "a missing file", path: () => join(tmpdir(), "pi-plan-mode-missing", "plan.json") },
    { name: "a blank file", path: () => planFile("  \n") },
    { name: "an object without modes", path: () => planFile({}) },
    { name: "modes without phases", path: () => planFile({ modes: {} }) },
];

for (const { name, path } of EMPTY_CONFIGS) {
    test(`loadPlanConfig treats ${name} as no configuration`, () => {
        assert.deepEqual(loadPlanConfig(path()), { modes: emptyModes(), errors: [] });
    });
}

const INVALID_CONFIGS: Array<{ name: string; contents: unknown; error: RegExp }> = [
    { name: "malformed JSON", contents: "{ not json", error: /plan\.json: / },
    { name: "a JSON array", contents: [], error: /expected a JSON object/ },
    { name: "modes that is not an object", contents: { modes: [] }, error: /"modes" must be an object/ },
    {
        name: "a phase that is not an object",
        contents: { modes: { brainstorming: "fast" } },
        error: /"modes\.brainstorming" must be an object/,
    },
    {
        name: "a model without a provider",
        contents: { modes: { implementing: { model: "deepseek-flash" } } },
        error: /"modes\.implementing\.model" must be "provider\/id"/,
    },
    {
        name: "a model that is not text",
        contents: { modes: { brainstorming: { model: 42 } } },
        error: /"modes\.brainstorming\.model" must be "provider\/id"/,
    },
    {
        name: "a thinking model without a provider",
        contents: { modes: { thinking: { model: "opus" } } },
        error: /"modes\.thinking\.model" must be "provider\/id"/,
    },
    {
        name: "a deny list that is not an array",
        contents: { modes: { brainstorming: { deniedTools: "mcp__k8s__*" } } },
        error: /"modes\.brainstorming\.deniedTools" must be an array/,
    },
];

for (const { name, contents, error } of INVALID_CONFIGS) {
    test(`loadPlanConfig reports ${name} and ignores the bad value`, () => {
        const config = loadPlanConfig(planFile(contents));
        assert.deepEqual(config.modes, emptyModes());
        assert.equal(config.errors.length, 1);
        assert.match(config.errors[0], error);
    });
}

test("a bare wildcard in the deny list is dropped and reported", () => {
    const config = loadPlanConfig(planFile({ modes: { brainstorming: { deniedTools: ["*", " * ", "task"] } } }));
    assert.deepEqual(config.modes.brainstorming.deniedTools, ["task"]);
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0], /every tool/);
});

test("a legacy allowedTools key is reported and the modes still load", () => {
    const config = loadPlanConfig(
        planFile({ allowedTools: ["mcp__docs__*"], modes: { brainstorming: { deniedTools: ["task"] } } }),
    );
    assert.deepEqual(config.modes.brainstorming.deniedTools, ["task"]);
    assert.equal(config.errors.length, 1);
    assert.match(config.errors[0], /"allowedTools" is no longer supported/);
});

test("one bad value does not discard the valid values next to it", () => {
    const config = loadPlanConfig(
        planFile({
            modes: { brainstorming: { model: "nope", deniedTools: ["task"] }, implementing: { model: "a/b" } },
        }),
    );
    assert.deepEqual(config.modes, {
        brainstorming: { deniedTools: ["task"] },
        implementing: { model: "a/b" },
        thinking: {},
    });
    assert.equal(config.errors.length, 1);
});
