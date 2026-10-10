import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPlanController } from "./plan.ts";
import { formatProposal, type PlanProposal } from "./proposal.ts";
import type { PlanModes } from "./planFile.ts";
import type { PlanModeData, PlanState, ThinkingLevel } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const MCP_TOOLS = ["mcp__browser__open", "mcp__browser__click", "mcp__docs__search"];
const ALL_TOOLS = [...FULL_TOOLS, ...MCP_TOOLS];
const BRAINSTORMING_TOOLS = ["read", "grep", "ls", "find", "plan_propose", "plan_ask"];
const PROPOSAL: PlanProposal = {
    description: "Simplify the proposal flow so one tool handles submission and acceptance.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify orchestration and remove duplicate actions",
            example: '"deniedTools": ["mcp__browser__*"]',
        },
        { path: "src/index.test.ts", change: "Cover the simplified registration" },
    ],
    tests: [
        {
            path: "src/plan.test.ts",
            test: "Rejects a proposal without a description",
            example: "await assert.rejects(h.controller.propose({ changes: [] }, h.ctx), /description/i)",
        },
    ],
};

/** Returns the first text block of a tool result. */
function resultText(result: { content: Array<{ text: string }> }): string {
    return result.content[0]?.text ?? "";
}

interface PlanHarnessOptions {
    tools?: string[];
    deniedTools?: string[];
    models?: { brainstorming?: string; implementing?: string; thinking?: string };
    levels?: { brainstorming?: ThinkingLevel; implementing?: ThinkingLevel; thinking?: ThinkingLevel };
    model?: string;
    available?: string[];
    setModelError?: Error;
    data?: PlanModeData;
    choices?: (string | undefined)[];
    inputs?: (string | undefined)[];
    hasUI?: boolean;
    profiles?: Array<{ key: string; name: string }>;
    loadPrompt?: (phase: PlanState) => string | null;
}

function createPlanHarness(options: PlanHarnessOptions = {}) {
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let setActiveToolsCalls = 0;
    let model = options.model;
    const models = options.models ?? {};
    const available = options.available ?? [model, models.brainstorming, models.implementing, models.thinking];
    const modelCalls: string[] = [];
    const persisted: PlanModeData[] = [];
    const displays: unknown[] = [];
    const sent: string[] = [];
    const notes: string[] = [];
    let status: string | undefined;
    let thinkingLevel: ThinkingLevel = "medium";
    let profileKey = "default";
    let profileName = "default";
    const profiles = options.profiles ?? [{ key: "default", name: "default" }];
    const resetCalls: number[] = [];
    const levelCalls: ThinkingLevel[] = [];
    const choices = options.choices ?? [];
    const inputs = options.inputs ?? [];

    const controller = createPlanController({
        getModes: (): PlanModes => ({
            brainstorming: {
                ...(models.brainstorming ? { model: models.brainstorming } : {}),
                ...(options.levels?.brainstorming ? { thinkingLevel: options.levels.brainstorming } : {}),
                deniedTools: options.deniedTools ?? [],
            },
            implementing: {
                ...(models.implementing ? { model: models.implementing } : {}),
                ...(options.levels?.implementing ? { thinkingLevel: options.levels.implementing } : {}),
            },
            thinking: {
                ...(models.thinking ? { model: models.thinking } : {}),
                ...(options.levels?.thinking ? { thinkingLevel: options.levels.thinking } : {}),
            },
        }),
        getActiveProfile: () => ({ key: profileKey, name: profileName }),
        listProfiles: () => profiles.map((profile) => ({ key: profile.key, name: profile.name })),
        setActiveProfile: (key) => {
            const found = profiles.find((profile) => profile.key === key);
            if (!found) return false;
            profileKey = found.key;
            profileName = found.name;
            return true;
        },
        resetActiveProfile: () => {
            resetCalls.push(1);
            profileKey = "default";
            profileName = "default";
            return { key: profileKey, name: profileName };
        },
        getDeniedTools: (phase) => (phase === "brainstorming" ? (options.deniedTools ?? []) : []),
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools) => {
            setActiveToolsCalls++;
            activeTools = [...tools];
        },
        getModel: () => model,
        setModel: async (ref) => {
            modelCalls.push(ref);
            if (options.setModelError) throw options.setModelError;
            if (!available.includes(ref)) return false;
            model = ref;
            return true;
        },
        getThinkingLevel: () => thinkingLevel,
        setThinkingLevel: (level) => {
            thinkingLevel = level;
            levelCalls.push(level);
        },
        persist: (data) => {
            persisted.push(data);
        },
        sendUserMessage: (message) => {
            sent.push(message);
        },
        displayProposal: (markdown) => {
            displays.push({ markdown });
        },
        loadPrompt: options.loadPrompt ?? ((phase) => `# ${phase}`),
    });

    const ctx = {
        hasUI: options.hasUI ?? true,
        ui: {
            setStatus: (_key: string, value?: string) => {
                status = value;
            },
            notify: (message: string) => {
                notes.push(message);
            },
            select: async () => choices.shift(),
            input: async () => inputs.shift(),
        },
    } as unknown as ExtensionContext;

    return {
        controller,
        ctx,
        start: (data?: PlanModeData) => controller.start(ctx, data),
        setActiveTools: (tools: string[]) => {
            activeTools = [...tools];
        },
        /** Simulates the user picking another model with /model. */
        pickModel: (ref: string) => {
            model = ref;
        },
        get activeTools() {
            return activeTools;
        },
        get setActiveToolsCalls() {
            return setActiveToolsCalls;
        },
        get status() {
            return status;
        },
        get model() {
            return model;
        },
        get thinkingLevel() {
            return thinkingLevel;
        },
        get profileKey() {
            return profileKey;
        },
        modelCalls,
        levelCalls,
        resetCalls,
        persisted,
        displays,
        sent,
        notes,
    };
}

/** Starts a harness; tool changes apply at once, and `ready` resolves after the model switch. */
function startHarness(options: PlanHarnessOptions = {}) {
    const harness = createPlanHarness(options);
    const ready = harness.start(options.data);
    return Object.assign(harness, { ready });
}

test("formatProposal renders the description, changes, tests, and examples", () => {
    const markdown = formatProposal(PROPOSAL);
    assert.match(markdown, /^## Description\nSimplify the proposal flow/);
    assert.match(markdown, /## Changes\n\n### `src\/index\.ts`\nSimplify orchestration/);
    assert.match(markdown, /Example:\n\n```\n"deniedTools": \["mcp__browser__\*"\]/);
    assert.match(markdown, /### `src\/index\.test\.ts`\nCover the simplified registration/);
    assert.match(markdown, /## Tests\n\n### `src\/plan\.test\.ts`\nRejects a proposal without a description/);
    assert.ok(markdown.indexOf("## Tests") > markdown.indexOf("### `src/index.test.ts`"));
});

test("fresh session enters brainstorming without the default denied tools", () => {
    const h = startHarness();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, BRAINSTORMING_TOOLS);
});

test("accepting restores the saved tools and enables plan_complete", async () => {
    const h = startHarness({ choices: ["Accept and implement"] });
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, ["read", "bash", "edit", "write", "plan_complete"]);
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    assert.deepEqual(h.displays, [{ markdown: formatProposal(PROPOSAL) }]);
});

test("propose stores and returns the formatted proposal without UI", async () => {
    const h = startHarness({ hasUI: false });
    const result = await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    assert.match(resultText(result), /## Description/);
});

test("propose accepts any descriptive path, including commands and absolute paths", async () => {
    const h = startHarness({ hasUI: false });
    const proposal = {
        ...PROPOSAL,
        changes: [
            { path: "/plan command", change: "Rename the slash command" },
            { path: "/home/user/.config/dotfiles/pi.nix", change: "Expose the binaries to the jail" },
            { path: "src/a..b.ts", change: "Handle double dots in names" },
        ],
        tests: [{ path: "../sibling/plan.test.ts", test: "Covers the shared flow" }],
    };
    await h.controller.propose(proposal, h.ctx);
    assert.deepEqual(h.persisted.at(-1)?.proposal, proposal);
});

test("propose accepts a proposal without tests", async () => {
    const h = startHarness({ hasUI: false });
    const { tests: _tests, ...withoutTests } = PROPOSAL;
    await h.controller.propose(withoutTests, h.ctx);
    assert.deepEqual(h.persisted.at(-1)?.proposal, withoutTests);
});

test("propose accepts legitimate words that resemble placeholders", async () => {
    const h = startHarness({ hasUI: false });
    const proposal = {
        ...PROPOSAL,
        changes: [{ path: "src/index.ts", change: "Handle unknown host names and CSV, JSON, etc." }],
    };
    await h.controller.propose(proposal, h.ctx);
    assert.deepEqual(h.persisted.at(-1)?.proposal, proposal);
});

test("rejecting clears the pending proposal and waits for feedback", async () => {
    const h = startHarness({ choices: ["Reject"] });
    const result = await h.controller.propose(PROPOSAL, h.ctx);
    assert.match(resultText(result), /rejected/i);
    assert.equal(h.persisted.at(-1)?.proposal, undefined);
    assert.equal(h.status, "plan: waiting for feedback");
});

test("rejection blocks new proposals and questions until user feedback", async () => {
    const h = startHarness({ choices: ["Reject"] });
    await h.controller.propose(PROPOSAL, h.ctx);
    await assert.rejects(h.controller.propose(PROPOSAL, h.ctx), /feedback/i);
    await assert.rejects(h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx), /feedback/i);
    h.controller.handleInput("interactive", h.ctx);
    assert.equal(h.status, "plan: brainstorming");
    await h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx);
});

test("closing the review without a choice rejects the proposal", async () => {
    const h = startHarness({ choices: [undefined] });
    const result = await h.controller.propose(PROPOSAL, h.ctx);
    assert.match(resultText(result), /rejected/i);
    assert.equal(h.persisted.at(-1)?.proposal, undefined);
    assert.equal(h.status, "plan: waiting for feedback");
});

test("plan_complete returns to brainstorming and clears the proposal", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    const result = await h.controller.complete(h.ctx);
    assert.match(resultText(result), /brainstorming/i);
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.persisted.at(-1)?.phase, "brainstorming");
    assert.equal(h.persisted.at(-1)?.proposal, undefined);
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
});

test("plan_complete waits for implementation tools to finish", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onToolExecutionStart("edit-1", "edit");
    await assert.rejects(h.controller.complete(h.ctx), /after all implementation tools finish/i);
    h.controller.onToolExecutionEnd("edit-1");
    await h.controller.complete(h.ctx);
    assert.equal(h.status, "plan: brainstorming");
});

test("agent_settled reminds once when idle mid-implementation", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onAgentSettled();
    assert.equal(h.sent.length, 1);
    h.controller.onAgentSettled();
    assert.equal(h.sent.length, 1);
});

test("agent_settled does not remind while tools are in flight", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onToolExecutionStart("edit-1", "edit");
    h.controller.onAgentSettled();
    assert.deepEqual(h.sent, []);
});

test("command completions follow the current phase", async () => {
    const h = startHarness({ data: { phase: "off", savedTools: FULL_TOOLS }, choices: ["Accept and implement"] });
    const values = (prefix: string) => h.controller.completions(prefix)?.map((item) => item.value) ?? null;
    assert.equal(values(""), null);
    await h.controller.command(undefined, h.ctx);
    assert.deepEqual(values(""), ["impl", "thk", "off", "reset", "profile"]);
    assert.deepEqual(values("im"), ["impl"]);
    assert.equal(values("nope"), null);
    assert.deepEqual(values("profile "), ["profile default"]);
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.deepEqual(values(""), ["bst", "off", "reset", "profile"]);
});

test("a missing phase prompt warns once and leaves the system prompt alone", () => {
    const h = startHarness({ loadPrompt: () => null });
    assert.equal(h.controller.beforeAgentStart("base", h.ctx), undefined);
    assert.equal(h.controller.beforeAgentStart("base", h.ctx), undefined);
    assert.equal(h.notes.filter((note) => /prompt .*missing/i.test(note)).length, 1);
});

test("/plan off works only while plan mode is on", async () => {
    const h = startHarness();
    await h.controller.command("off", h.ctx);
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    await h.controller.command("off", h.ctx);
    assert.match(h.notes.at(-1) ?? "", /run \/plan to start/i);
});

test("/plan off is blocked while implementation tools are in flight", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onToolExecutionStart("edit-1", "edit");
    await h.controller.command("off", h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.match(h.notes.at(-1) ?? "", /wait for implementation tools/i);
});

test("invalid control tool transition throws", async () => {
    const h = startHarness();
    await assert.rejects(h.controller.complete(h.ctx), /implementing/i);
});

test("plan_ask returns a selected option as the answer", async () => {
    const h = startHarness({ choices: ["Blue"] });
    const result = await h.controller.ask(
        { questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }] },
        h.ctx,
    );
    assert.match(resultText(result), /Q: Favorite color\?\nA: Blue/);
});

test("plan_ask falls back to free text when the user picks Other", async () => {
    const h = startHarness({ choices: ["Other (type your own)"], inputs: ["Green"] });
    const result = await h.controller.ask(
        { questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }] },
        h.ctx,
    );
    assert.match(resultText(result), /A: Green/);
});

test("plan_ask degrades gracefully without a UI", async () => {
    const h = startHarness({ hasUI: false });
    const result = await h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx);
    assert.match(resultText(result), /require a UI session/i);
});

test("prompt composition appends the proposal during implementation", () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    const result = h.controller.beforeAgentStart("base", h.ctx);
    assert.match(result?.systemPrompt ?? "", /## Description\nSimplify the proposal flow/);
    assert.match(result?.systemPrompt ?? "", /### `src\/index\.ts`/);
    assert.match(result?.systemPrompt ?? "", /## Tests/);
});

const DEFAULT_DENIED = ["bash", "powershell", "edit", "write"];

for (const tool of DEFAULT_DENIED) {
    test(`brainstorming always blocks the default denied tool ${tool}`, () => {
        const h = startHarness({ tools: [...ALL_TOOLS, "powershell"] });
        assert.ok(!h.activeTools.includes(tool));
        assert.match(h.controller.blockReason(tool) ?? "", /not available during brainstorming/i);
    });
}

test("configured denied tools are inactive and blocked, by exact name or prefix", () => {
    const h = startHarness({ tools: ALL_TOOLS, deniedTools: ["mcp__browser__click", "mcp__docs__*"] });
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "mcp__browser__open", "plan_propose", "plan_ask"]);
    for (const denied of ["mcp__browser__click", "mcp__docs__search"]) {
        assert.match(h.controller.blockReason(denied) ?? "", /not available/i, denied);
    }
    assert.equal(h.controller.blockReason("mcp__browser__open"), undefined);
});

test("a deny entry can remove a discovery tool", () => {
    const h = startHarness({ deniedTools: ["grep"] });
    assert.deepEqual(h.activeTools, ["read", "ls", "find", "plan_propose", "plan_ask"]);
    assert.match(h.controller.blockReason("grep") ?? "", /not available/i);
});

test("a deny entry never blocks the plan control tools", () => {
    const h = startHarness({ deniedTools: ["plan_*"] });
    assert.deepEqual(h.activeTools, BRAINSTORMING_TOOLS);
    assert.equal(h.controller.blockReason("plan_propose"), undefined);
});

test("implementation does not block default or configured denied tools", () => {
    const h = startHarness({
        deniedTools: ["mcp__docs__*"],
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    assert.equal(h.controller.blockReason("bash"), undefined);
    assert.equal(h.controller.blockReason("mcp__docs__search"), undefined);
});

test("leaving plan mode drops the tools plan mode added and keeps later ones", async () => {
    const h = startHarness({ tools: ALL_TOOLS });
    h.setActiveTools([...h.activeTools, "mcp__late__tool"]);
    await h.controller.command("off", h.ctx);
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "mcp__late__tool"]);
});

test("a tool that connects after startup is adopted, and denied ones stay inactive", async () => {
    const h = startHarness({ tools: FULL_TOOLS, deniedTools: ["mcp__browser__*"] });
    h.setActiveTools([...h.activeTools, "mcp__docs__search", "mcp__browser__open"]);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "mcp__docs__search", "plan_propose", "plan_ask"]);
    assert.equal(h.controller.blockReason("mcp__docs__search"), undefined);
    assert.match(h.controller.blockReason("mcp__browser__open") ?? "", /not available/i);
    await h.controller.command("off", h.ctx);
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "mcp__docs__search", "mcp__browser__open"]);
});

test("syncing tools does nothing when the active set is already correct", () => {
    const h = startHarness({ tools: ALL_TOOLS, deniedTools: ["mcp__browser__*"] });
    const calls = h.setActiveToolsCalls;
    h.controller.beforeAgentStart("base", h.ctx);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.equal(h.setActiveToolsCalls, calls);
});

test("a tool that connects during implementation is denied again after completion", async () => {
    const h = startHarness({
        deniedTools: ["mcp__docs__*"],
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.setActiveTools([...h.activeTools, "mcp__docs__search"]);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.ok(h.activeTools.includes("mcp__docs__search"));
    await h.controller.complete(h.ctx);
    assert.deepEqual(h.activeTools, BRAINSTORMING_TOOLS);
});

test("plan control tools are removed while plan mode is off", () => {
    const h = startHarness({
        tools: [...FULL_TOOLS, "plan_propose", "plan_complete", "plan_ask"],
        data: { phase: "off", savedTools: FULL_TOOLS },
    });
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    h.setActiveTools([...FULL_TOOLS, "plan_propose"]);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("persisted plan state is a snapshot, not a live reference", async () => {
    const h = startHarness({ hasUI: false });
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.persisted[0]?.proposal, undefined);
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    assert.notEqual(h.persisted[0], h.persisted.at(-1));
});

test("resuming another branch restores that branch's phase and tools", async () => {
    const h = startHarness({ tools: ALL_TOOLS, deniedTools: ["mcp__browser__click"] });
    await h.controller.resume(h.ctx, { phase: "off", savedTools: [] });
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, ALL_TOOLS);
    await h.controller.resume(h.ctx, { phase: "implementing", proposal: PROPOSAL, savedTools: [] });
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "plan_complete"]);
    await h.controller.resume(h.ctx, { phase: "brainstorming", savedTools: [] });
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, [
        "read",
        "grep",
        "ls",
        "find",
        "mcp__browser__open",
        "mcp__docs__search",
        "plan_propose",
        "plan_ask",
    ]);
});

test("resuming an off branch while plan mode is off leaves the tools alone", () => {
    const h = startHarness({ data: { phase: "off", savedTools: FULL_TOOLS } });
    const calls = h.setActiveToolsCalls;
    h.controller.resume(h.ctx, { phase: "off", savedTools: ["bash"] });
    assert.equal(h.setActiveToolsCalls, calls);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

const MODELS = { brainstorming: "p/plan", implementing: "p/build" };

test("a fresh session switches to the brainstorming model and saves the user's model", async () => {
    const h = startHarness({ model: "p/user", models: MODELS });
    await h.ready;
    assert.equal(h.model, "p/plan");
    assert.equal(h.persisted.at(-1)?.savedModel, "p/user");
});

test("each phase change switches to that phase's model", async () => {
    const h = startHarness({ model: "p/user", models: MODELS, choices: ["Accept and implement"] });
    await h.ready;
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.model, "p/build");
    await h.controller.complete(h.ctx);
    assert.equal(h.model, "p/plan");
});

test("/plan off restores the model saved before the first switch", async () => {
    const h = startHarness({ model: "p/user", models: MODELS, choices: ["Accept and implement"] });
    await h.ready;
    await h.controller.propose(PROPOSAL, h.ctx);
    await h.controller.command("off", h.ctx);
    assert.equal(h.model, "p/user");
    assert.equal(h.persisted.at(-1)?.savedModel, undefined);
});

test("a phase without a model returns to the saved model", async () => {
    const h = startHarness({
        model: "p/user",
        models: { brainstorming: "p/plan" },
        choices: ["Accept and implement"],
    });
    await h.ready;
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.model, "p/user");
});

test("without configured models the model never changes", async () => {
    const h = startHarness({ model: "p/user", choices: ["Accept and implement"] });
    await h.ready;
    h.pickModel("p/manual");
    await h.controller.propose(PROPOSAL, h.ctx);
    await h.controller.command("off", h.ctx);
    assert.equal(h.model, "p/manual");
    assert.deepEqual(h.modelCalls, []);
});

test("an unavailable model warns, keeps the current model, and still changes phase", async () => {
    const h = startHarness({ model: "p/user", models: { brainstorming: "p/missing" }, available: ["p/user"] });
    await h.ready;
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.model, "p/user");
    assert.match(h.notes.at(-1) ?? "", /cannot switch to the model "p\/missing"/);
    assert.equal(h.persisted.at(-1)?.savedModel, undefined);
});

test("a model switch that throws warns with the reason", async () => {
    const h = startHarness({ model: "p/user", models: MODELS, setModelError: new Error("no credentials for p") });
    await h.ready;
    assert.equal(h.model, "p/user");
    assert.match(h.notes.at(-1) ?? "", /no credentials for p/);
});

test("a manual model change stays until the next phase change", async () => {
    const h = startHarness({ model: "p/user", models: MODELS, choices: ["Accept and implement"] });
    await h.ready;
    h.pickModel("p/manual");
    h.controller.beforeAgentStart("base", h.ctx);
    assert.equal(h.model, "p/manual");
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.model, "p/build");
    await h.controller.command("off", h.ctx);
    assert.equal(h.model, "p/user");
});

test("a restored implementing state applies the implementing model", async () => {
    const h = startHarness({
        model: "p/plan",
        models: MODELS,
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS, savedModel: "p/user" },
    });
    await h.ready;
    assert.equal(h.model, "p/build");
});

test("resuming a branch applies the model of the resumed phase", async () => {
    const h = startHarness({ model: "p/user", models: MODELS });
    await h.ready;
    await h.controller.resume(h.ctx, { phase: "implementing", proposal: PROPOSAL, savedTools: [] });
    assert.equal(h.model, "p/build");
    await h.controller.resume(h.ctx, { phase: "off", savedTools: [] });
    assert.equal(h.model, "p/user");
});

const IMPLEMENTING: PlanModeData = { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS };

test("/plan bst returns from implementing, keeps the proposal, and waits for feedback", async () => {
    const h = startHarness({ data: IMPLEMENTING });
    await h.controller.command("bst", h.ctx);
    assert.equal(h.status, "plan: waiting for feedback");
    assert.deepEqual(h.activeTools, BRAINSTORMING_TOOLS);
    assert.equal(h.persisted.at(-1)?.phase, "brainstorming");
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    assert.equal(h.persisted.at(-1)?.waitingForUserFeedback, true);
    await assert.rejects(h.controller.propose(PROPOSAL, h.ctx), /feedback/i);
});

test("/plan bst waits for implementation tools to finish", async () => {
    const h = startHarness({ data: IMPLEMENTING });
    h.controller.onToolExecutionStart("edit-1", "edit");
    await h.controller.command("bst", h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.match(h.notes.at(-1) ?? "", /wait for implementation tools to finish/i);
});

const BRAINSTORM_ELSEWHERE: Array<{ name: string; data: PlanModeData; note: RegExp }> = [
    {
        name: "brainstorming",
        data: { phase: "brainstorming", savedTools: FULL_TOOLS },
        note: /works only while implementing/i,
    },
    { name: "off", data: { phase: "off", savedTools: FULL_TOOLS }, note: /run \/plan to start/i },
];

for (const { name, data, note } of BRAINSTORM_ELSEWHERE) {
    test(`/plan bst while ${name} changes nothing and explains why`, async () => {
        const h = startHarness({ data });
        const before = h.persisted.length;
        await h.controller.command("bst", h.ctx);
        assert.equal(h.persisted.length, before);
        assert.match(h.notes.at(-1) ?? "", note);
    });
}

test("start does not change the restored state it receives", async () => {
    const restored: PlanModeData = { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS };
    const h = startHarness({ data: restored });
    await h.controller.command("bst", h.ctx);
    assert.deepEqual(restored, { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS });
});

test("/plan impl accepts the stored proposal without the review dialog", async () => {
    const h = startHarness({ data: { phase: "brainstorming", proposal: PROPOSAL, savedTools: FULL_TOOLS } });
    await h.controller.command("impl", h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "plan_complete"]);
    assert.deepEqual(h.displays, []);
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
});

test("/plan impl after /plan bst resumes the kept proposal and stops waiting for feedback", async () => {
    const h = startHarness({ data: IMPLEMENTING });
    await h.controller.command("bst", h.ctx);
    await h.controller.command("impl", h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.equal(h.persisted.at(-1)?.waitingForUserFeedback, undefined);
});

const IMPL_ELSEWHERE: Array<{ name: string; data: PlanModeData; note: RegExp }> = [
    {
        name: "brainstorming without a proposal",
        data: { phase: "brainstorming", savedTools: FULL_TOOLS },
        note: /no stored proposal/i,
    },
    { name: "implementing", data: IMPLEMENTING, note: /works only while brainstorming/i },
    { name: "off", data: { phase: "off", savedTools: FULL_TOOLS }, note: /run \/plan to start/i },
];

for (const { name, data, note } of IMPL_ELSEWHERE) {
    test(`/plan impl while ${name} changes nothing and explains why`, async () => {
        const h = startHarness({ data });
        const before = h.persisted.length;
        await h.controller.command("impl", h.ctx);
        assert.equal(h.persisted.length, before);
        assert.match(h.notes.at(-1) ?? "", note);
    });
}

const VAGUE_PROPOSALS: Array<{ name: string; proposal: PlanProposal; error: RegExp }> = [
    {
        name: "a description that is too short",
        proposal: { ...PROPOSAL, description: "ok" },
        error: /description is empty or overly short/i,
    },
    {
        name: "a change path that is too short",
        proposal: { ...PROPOSAL, changes: [{ path: "x", change: "Rename the command" }] },
        error: /meaningful path and description/i,
    },
    {
        name: "a change text that is too short",
        proposal: { ...PROPOSAL, changes: [{ path: "src/index.ts", change: "ok" }] },
        error: /meaningful path and description/i,
    },
    {
        name: "a test text that is too short",
        proposal: { ...PROPOSAL, tests: [{ path: "src/plan.test.ts", test: "ok" }] },
        error: /meaningful path and behavior/i,
    },
    { name: "placeholder text", proposal: { ...PROPOSAL, description: "TBD" }, error: /placeholder/i },
];

for (const { name, proposal, error } of VAGUE_PROPOSALS) {
    test(`propose rejects ${name} and stores nothing`, async () => {
        const h = startHarness();
        await assert.rejects(h.controller.propose(proposal, h.ctx), error);
        assert.equal(h.persisted.at(-1)?.proposal, undefined);
    });
}

test("an unknown /plan subcommand changes nothing and names the subcommand", async () => {
    const h = startHarness();
    const before = h.persisted.length;
    await h.controller.command("nope", h.ctx);
    assert.equal(h.persisted.length, before);
    assert.match(h.notes.at(-1) ?? "", /unknown subcommand "nope"/);
});

test("/plan while plan mode is on changes nothing and names the phase", async () => {
    const h = startHarness();
    const before = h.persisted.length;
    await h.controller.command(undefined, h.ctx);
    assert.equal(h.persisted.length, before);
    assert.match(h.notes.at(-1) ?? "", /already on \(brainstorming\)/);
});

const THINKING_MODELS = { brainstorming: "p/plan", thinking: "p/think", implementing: "p/build" };

test("/plan thk toggles the thinking model during brainstorming", async () => {
    const h = startHarness({ model: "p/user", models: THINKING_MODELS });
    await h.ready;
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/think");
    assert.equal(h.status, "plan: thinking");
    assert.equal(h.persisted.at(-1)?.thinking, true);
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/plan");
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.persisted.at(-1)?.thinking, undefined);
});

test("thinking keeps the brainstorming tools and deny list", async () => {
    const h = startHarness({ tools: ALL_TOOLS, models: THINKING_MODELS, deniedTools: ["mcp__browser__click"] });
    const before = [...h.activeTools];
    await h.controller.command("thk", h.ctx);
    assert.deepEqual(h.activeTools, before);
    assert.match(h.controller.blockReason("edit") ?? "", /not available/i);
    assert.match(h.controller.blockReason("mcp__browser__click") ?? "", /not available/i);
});

test("/plan thk without a thinking model warns and changes nothing", async () => {
    const h = startHarness({ model: "p/user", models: { brainstorming: "p/plan" } });
    await h.ready;
    const before = h.persisted.length;
    await h.controller.command("thk", h.ctx);
    assert.equal(h.persisted.length, before);
    assert.equal(h.model, "p/plan");
    assert.match(h.notes.at(-1) ?? "", /thinking/);
});

test("/plan thk works only while brainstorming", async () => {
    const h = startHarness({ models: THINKING_MODELS, data: IMPLEMENTING });
    await h.controller.command("thk", h.ctx);
    assert.equal(h.status, "plan: implementing");
    assert.match(h.notes.at(-1) ?? "", /works only while brainstorming/);
});

test("accepting while thinking implements on the implementing model and ends thinking", async () => {
    const h = startHarness({ model: "p/user", models: THINKING_MODELS, choices: ["Accept and implement"] });
    await h.ready;
    await h.controller.command("thk", h.ctx);
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.model, "p/build");
    assert.equal(h.persisted.at(-1)?.thinking, undefined);
    await h.controller.complete(h.ctx);
    assert.equal(h.model, "p/plan");
    assert.equal(h.status, "plan: brainstorming");
});

test("turning thinking off without a brainstorming model returns to the user's model", async () => {
    const h = startHarness({ model: "p/user", models: { thinking: "p/think" } });
    await h.ready;
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/think");
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/user");
});

test("a restored or resumed thinking state uses the thinking model", async () => {
    const h = startHarness({
        model: "p/user",
        models: THINKING_MODELS,
        data: { phase: "brainstorming", savedTools: FULL_TOOLS, thinking: true },
    });
    await h.ready;
    assert.equal(h.model, "p/think");
    assert.equal(h.status, "plan: thinking");
    await h.controller.resume(h.ctx, { phase: "brainstorming", savedTools: [] });
    assert.equal(h.model, "p/plan");
    await h.controller.resume(h.ctx, { phase: "brainstorming", savedTools: [], thinking: true });
    assert.equal(h.model, "p/think");
});

const OVERRIDE_MODELS = { brainstorming: "p/plan", implementing: "p/build" };

test("a captured override applies to the active stage and survives a phase round trip", async () => {
    const h = startHarness({
        model: "p/user",
        models: OVERRIDE_MODELS,
        available: ["p/user", "p/plan", "p/build", "p/custom"],
        choices: ["Accept and implement"],
    });
    await h.ready;
    h.pickModel("p/custom");
    h.controller.captureOverride({ model: "p/custom" }, h.ctx);
    assert.equal(h.status, "plan: brainstorming (override)");
    assert.equal(h.persisted.at(-1)?.overrides?.default?.brainstorming?.model, "p/custom");
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.model, "p/build");
    await h.controller.command("bst", h.ctx);
    assert.equal(h.model, "p/custom");
    assert.equal(h.status, "plan: waiting for feedback (override)");
});

test("an override for the thinking stage does not change brainstorming", async () => {
    const h = startHarness({ model: "p/user", models: THINKING_MODELS });
    await h.ready;
    await h.controller.command("thk", h.ctx);
    h.controller.captureOverride({ thinkingLevel: "max" }, h.ctx);
    assert.equal(h.persisted.at(-1)?.overrides?.default?.thinking?.thinkingLevel, "max");
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/plan");
    await h.controller.command("thk", h.ctx);
    assert.equal(h.model, "p/think");
    assert.equal(h.thinkingLevel, "max");
});

test("/plan reset clears overrides and the session profile and re-applies the config", async () => {
    const h = startHarness({
        model: "p/user",
        models: OVERRIDE_MODELS,
        profiles: [
            { key: "default", name: "default" },
            { key: "work", name: "work" },
        ],
    });
    await h.ready;
    await h.controller.command("profile work", h.ctx);
    assert.equal(h.profileKey, "work");
    h.controller.captureOverride({ model: "p/custom" }, h.ctx);
    await h.controller.command("reset", h.ctx);
    assert.equal(h.profileKey, "default");
    assert.equal(h.resetCalls.length, 1);
    assert.equal(h.persisted.at(-1)?.overrides, undefined);
    assert.match(h.notes.at(-1) ?? "", /overrides cleared/);
    assert.equal(h.model, "p/plan");
});

test("the profile command lists profiles and warns on an unknown key", async () => {
    const h = startHarness({
        profiles: [
            { key: "default", name: "default" },
            { key: "work", name: "work" },
        ],
    });
    await h.ready;
    await h.controller.command("profile", h.ctx);
    assert.match(h.notes.at(-1) ?? "", /profiles: default \(active\), work/);
    await h.controller.command("profile nope", h.ctx);
    assert.match(h.notes.at(-1) ?? "", /unknown profile "nope"/);
});

test("a configured ban blocks a tool in brainstorming but not in implementing", async () => {
    const h = startHarness({
        deniedTools: ["mcp__browser__open"],
        tools: ALL_TOOLS,
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    await h.ready;
    assert.equal(h.controller.blockReason("mcp__browser__open"), undefined);
    await h.controller.command("bst", h.ctx);
    assert.match(h.controller.blockReason("mcp__browser__open") ?? "", /not available during brainstorming/);
});

test("a stage thinking level is applied when its phase starts", async () => {
    const h = startHarness({
        model: "p/user",
        models: OVERRIDE_MODELS,
        levels: { brainstorming: "high", implementing: "low" },
        choices: ["Accept and implement"],
    });
    await h.ready;
    assert.equal(h.thinkingLevel, "high");
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.thinkingLevel, "low");
});

test("a configured thinking level is saved and restored around plan mode", async () => {
    const h = startHarness({ model: "p/user", models: { brainstorming: "p/plan" }, levels: { brainstorming: "high" } });
    await h.ready;
    assert.equal(h.thinkingLevel, "high");
    assert.equal(h.persisted.at(-1)?.savedThinkingLevel, "medium");
    await h.controller.command("off", h.ctx);
    assert.equal(h.thinkingLevel, "medium");
    assert.equal(h.model, "p/user");
});

test("a level-only stage still restores the original level after a round trip", async () => {
    const h = startHarness({
        models: { implementing: "p/build" },
        levels: { brainstorming: "high" },
        choices: ["Accept and implement"],
    });
    await h.ready;
    assert.equal(h.thinkingLevel, "high");
    await h.controller.propose(PROPOSAL, h.ctx);
    await h.controller.command("bst", h.ctx);
    await h.controller.command("off", h.ctx);
    assert.equal(h.thinkingLevel, "medium");
});
