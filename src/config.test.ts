import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveDeniedTools, loadPlanConfigs, selectProfile, type PlanConfig } from "./config.ts";
import { emptyModes, splitModelRef } from "./planFile.ts";
import { findLocalPlanConfig } from "./paths.ts";

/** Loads one file and returns the default profile's modes, as the single-file API did before profiles. */
function loadPlanConfig(path: string): { modes: ReturnType<typeof emptyModes>; errors: string[] } {
    const config = loadPlanConfigs(path);
    return { modes: selectProfile(config, "/").modes, errors: config.errors };
}

/** Returns the one error a config carries, which these assertions guarantee. */
function firstError(errors: string[]): string {
    return errors[0] ?? "";
}

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
        assert.match(firstError(config.errors), error);
    });
}

test("a bare wildcard in the deny list is dropped and reported", () => {
    const config = loadPlanConfig(planFile({ modes: { brainstorming: { deniedTools: ["*", " * ", "task"] } } }));
    assert.deepEqual(config.modes.brainstorming.deniedTools, ["task"]);
    assert.equal(config.errors.length, 1);
    assert.match(firstError(config.errors), /every tool/);
});

test("a legacy allowedTools key is reported and the modes still load", () => {
    const config = loadPlanConfig(
        planFile({ allowedTools: ["mcp__docs__*"], modes: { brainstorming: { deniedTools: ["task"] } } }),
    );
    assert.deepEqual(config.modes.brainstorming.deniedTools, ["task"]);
    assert.equal(config.errors.length, 1);
    assert.match(firstError(config.errors), /"allowedTools" is no longer supported/);
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

test("profiles parse per-stage models, thinking levels, and bans", () => {
    const config = loadPlanConfigs(
        planFile({
            activeProfile: "work",
            deniedTools: ["global_tool"],
            profiles: {
                work: {
                    deniedTools: ["profile_tool"],
                    brainstorming: { model: "a/b", thinkingLevel: "high", deniedTools: ["stage_tool"] },
                    thinking: { model: "a/c", thinkingLevel: "max" },
                    implementing: { model: "a/d", thinkingLevel: "low" },
                },
            },
        }),
    );
    assert.deepEqual(config.errors, []);
    assert.equal(config.activeProfile, "work");
    const work = config.profiles.find((profile) => profile.key === "work");
    assert.deepEqual(work?.modes.brainstorming, {
        model: "a/b",
        thinkingLevel: "high",
        deniedTools: ["stage_tool"],
    });
    assert.deepEqual(work?.modes.thinking, { model: "a/c", thinkingLevel: "max" });
    assert.deepEqual(work?.modes.implementing, { model: "a/d", thinkingLevel: "low" });
    assert.deepEqual(work?.deniedTools, ["profile_tool"]);
});

test("a bad thinking level is reported and ignored", () => {
    const config = loadPlanConfigs(planFile({ profiles: { default: { implementing: { thinkingLevel: "loud" } } } }));
    assert.equal(config.errors.length, 1);
    assert.match(firstError(config.errors), /thinkingLevel/);
    assert.deepEqual(selectProfile(config, "/").modes.implementing, {});
});

test("a legacy top-level modes object becomes the default profile", () => {
    const config = loadPlanConfigs(planFile({ modes: { implementing: { model: "a/b" } } }));
    assert.deepEqual(selectProfile(config, "/").modes, {
        brainstorming: { deniedTools: [] },
        implementing: { model: "a/b" },
        thinking: {},
    });
});

test("a local profile extends the same-named global profile", () => {
    const global = planFile({
        profiles: {
            work: {
                deniedTools: ["global_ban"],
                brainstorming: { model: "a/plan", thinkingLevel: "high", deniedTools: ["stage_ban"] },
                implementing: { model: "a/build" },
            },
        },
    });
    const local = planFile({
        activeProfile: "work",
        deniedTools: ["local_ban"],
        profiles: {
            work: { implementing: { model: "a/local", thinkingLevel: "low" } },
            scratch: { brainstorming: { model: "a/scratch" }, thinking: { thinkingLevel: "max" } },
        },
    });
    const config = loadPlanConfigs(global, local);
    assert.deepEqual(config.errors, []);
    const work = config.profiles.find((profile) => profile.key === "local:work");
    assert.equal(work?.name, "work (local)");
    assert.equal(work?.rank, "local");
    assert.deepEqual(work?.modes.brainstorming, {
        model: "a/plan",
        thinkingLevel: "high",
        deniedTools: ["stage_ban"],
    });
    assert.deepEqual(work?.modes.implementing, { model: "a/local", thinkingLevel: "low" });
    assert.deepEqual(work?.deniedTools, ["global_ban"]);
    const scratch = config.profiles.find((profile) => profile.key === "local:scratch");
    assert.deepEqual(scratch?.modes.thinking, { thinkingLevel: "max" });
    assert.deepEqual(scratch?.modes.brainstorming, { model: "a/scratch", deniedTools: [] });
    assert.equal(selectProfile(config, "/").key, "local:work");
});

test("effectiveDeniedTools unions every layer only during brainstorming", () => {
    const global = planFile({
        deniedTools: ["g"],
        profiles: { work: { deniedTools: ["p"], brainstorming: { deniedTools: ["s"] } } },
    });
    const local = planFile({ deniedTools: ["l"], profiles: { work: {} } });
    const config = loadPlanConfigs(global, local);
    assert.deepEqual(effectiveDeniedTools(config, "local:work", "brainstorming"), ["g", "l", "p", "s"]);
    assert.deepEqual(effectiveDeniedTools(config, "local:work", "implementing"), []);
});

test("a circular extends chain is reported", () => {
    const config = loadPlanConfigs(planFile({ profiles: { a: { extends: "b" }, b: { extends: "a" } } }));
    assert.match(config.errors.join("\n"), /circular/);
});

test("a profile name ending in (local) is rejected", () => {
    const config = loadPlanConfigs(planFile({ profiles: { "work (local)": {} } }));
    assert.equal(
        config.profiles.some((profile) => profile.key === "work (local)"),
        false,
    );
    assert.match(config.errors.join("\n"), /\(local\)/);
});

test("selectProfile prefers the configured default, then a match, then default", () => {
    const config: PlanConfig = {
        profiles: [
            { key: "work", name: "work", rank: "global", match: ["/work/**"], deniedTools: [], modes: emptyModes() },
            { key: "default", name: "default", rank: "global", match: [], deniedTools: [], modes: emptyModes() },
        ],
        activeProfile: undefined,
        globalDeniedTools: [],
        localDeniedTools: [],
        errors: [],
    };
    assert.equal(selectProfile(config, "/work/proj").key, "work");
    assert.equal(selectProfile(config, "/home/me").key, "default");
    assert.equal(selectProfile({ ...config, activeProfile: "default" }, "/work/proj").key, "default");
});

test("findLocalPlanConfig walks up to the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-plan-mode-root-"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".git"), "");
    assert.equal(findLocalPlanConfig(nested), undefined);
    writeFileSync(join(root, ".plan.json"), "{}");
    assert.equal(findLocalPlanConfig(nested), join(root, ".plan.json"));
});
