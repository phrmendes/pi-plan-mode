import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPlanController, formatProposal } from "./plan.ts";
import type { PlanModeData, PlanProposal, PlanState } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const MCP_TOOLS = ["mcp__browser__open", "mcp__browser__click", "mcp__docs__search"];
const ALL_TOOLS = [...FULL_TOOLS, ...MCP_TOOLS];
const PROPOSAL: PlanProposal = {
    description: "Simplify the proposal flow so one tool handles submission and acceptance.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify orchestration and remove duplicate actions",
            example: 'planMode(pi, { allowedTools: ["mcp__browser__*"] })',
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

interface PlanHarnessOptions {
    tools?: string[];
    allowedTools?: string[];
    data?: PlanModeData;
    choices?: (string | undefined)[];
    inputs?: (string | undefined)[];
    hasUI?: boolean;
    loadPrompt?: (phase: PlanState) => string | null;
}

function createPlanHarness(options: PlanHarnessOptions = {}) {
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let setActiveToolsCalls = 0;
    const persisted: PlanModeData[] = [];
    const displays: unknown[] = [];
    const sent: string[] = [];
    const notes: string[] = [];
    let status: string | undefined;
    const choices = options.choices ?? [];
    const inputs = options.inputs ?? [];

    const controller = createPlanController({
        getAllowedTools: () => options.allowedTools ?? [],
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools) => {
            setActiveToolsCalls++;
            activeTools = [...tools];
        },
        persist: (data) => {
            persisted.push(data);
        },
        sendUserMessage: (message) => {
            sent.push(message);
        },
        appendDisplay: (_type, data) => {
            displays.push(data);
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
        get activeTools() {
            return activeTools;
        },
        get setActiveToolsCalls() {
            return setActiveToolsCalls;
        },
        get status() {
            return status;
        },
        persisted,
        displays,
        sent,
        notes,
    };
}

function startHarness(options: PlanHarnessOptions = {}) {
    const harness = createPlanHarness(options);
    harness.start(options.data);
    return harness;
}

test("formatProposal renders the description, changes, tests, and examples", () => {
    const markdown = formatProposal(PROPOSAL);
    assert.match(markdown, /^## Description\nSimplify the proposal flow/);
    assert.match(markdown, /## Changes\n\n### `src\/index\.ts`\nSimplify orchestration/);
    assert.match(markdown, /Example:\n\n```\nplanMode\(pi, \{ allowedTools: \["mcp__browser__\*"\] \}\)/);
    assert.match(markdown, /### `src\/index\.test\.ts`\nCover the simplified registration/);
    assert.match(markdown, /## Tests\n\n### `src\/plan\.test\.ts`\nRejects a proposal without a description/);
    assert.ok(markdown.indexOf("## Tests") > markdown.indexOf("### `src/index.test.ts`"));
});

test("fresh session enters brainstorming with the restricted tool set", () => {
    const h = startHarness();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
    assert.ok(!h.activeTools.includes("bash"));
    assert.ok(!h.activeTools.includes("edit"));
    assert.ok(!h.activeTools.includes("write"));
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
    assert.match(result.content[0].text, /## Description/);
});

test("propose rejects placeholder content", async () => {
    const h = startHarness();
    await assert.rejects(h.controller.propose({ ...PROPOSAL, description: "TBD" }, h.ctx), /placeholder/i);
});

test("propose rejects a meaningless test entry", async () => {
    const h = startHarness();
    const proposal = { ...PROPOSAL, tests: [{ path: "src/plan.test.ts", test: "ok" }] };
    await assert.rejects(h.controller.propose(proposal, h.ctx), /meaningful path and behavior/i);
});

test("propose accepts any descriptive path, including commands and absolute paths", async () => {
    const h = startHarness();
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
    const h = startHarness();
    const { tests: _tests, ...withoutTests } = PROPOSAL;
    await h.controller.propose(withoutTests, h.ctx);
    assert.deepEqual(h.persisted.at(-1)?.proposal, withoutTests);
});

test("propose accepts legitimate words that resemble placeholders", async () => {
    const h = startHarness();
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
    assert.match(result.content[0].text, /rejected/i);
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

test("asking for review keeps the proposal for plan review", async () => {
    const h = startHarness({ choices: ["Ask for review", "Accept and implement"] });
    const result = await h.controller.propose(PROPOSAL, h.ctx);
    assert.match(result.content[0].text, /\/plan review/);
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    await h.controller.command("review", h.ctx);
    assert.equal(h.status, "plan: implementing");
});

test("plan_complete disables plan mode and clears the proposal", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    const result = await h.controller.complete(h.ctx);
    assert.match(result.content[0].text, /disabled/);
    assert.equal(h.status, undefined);
    assert.equal(h.persisted.at(-1)?.proposal, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("plan_complete waits for implementation tools to finish", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onToolExecutionStart("edit-1", "edit");
    await assert.rejects(h.controller.complete(h.ctx), /after all implementation tools finish/i);
    h.controller.onToolExecutionEnd("edit-1");
    await h.controller.complete(h.ctx);
    assert.equal(h.status, undefined);
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
    const h = startHarness({ data: { phase: "off", savedTools: FULL_TOOLS } });
    assert.deepEqual(h.controller.completions(""), null);
    await h.controller.command(undefined, h.ctx);
    assert.deepEqual(
        h.controller.completions("")?.map((item) => item.value),
        ["review", "disable"],
    );
    assert.deepEqual(
        h.controller.completions("re")?.map((item) => item.value),
        ["review"],
    );
    assert.deepEqual(h.controller.completions("nope"), null);
});

test("review reports when no proposal is stored", async () => {
    const h = startHarness();
    await h.controller.command("review", h.ctx);
    assert.match(h.notes.at(-1) ?? "", /no stored proposal/i);
});

test("disable is available only while plan mode is enabled", async () => {
    const h = startHarness();
    await h.controller.command("disable", h.ctx);
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    await h.controller.command("disable", h.ctx);
    assert.match(h.notes.at(-1) ?? "", /already disabled/i);
});

test("disable is blocked while implementation tools are in flight", async () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS },
    });
    h.controller.onToolExecutionStart("edit-1", "edit");
    await h.controller.command("disable", h.ctx);
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
    assert.match(result.content[0].text, /Q: Favorite color\?\nA: Blue/);
});

test("plan_ask falls back to free text when the user picks Other", async () => {
    const h = startHarness({ choices: ["Other (type your own)"], inputs: ["Green"] });
    const result = await h.controller.ask(
        { questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }] },
        h.ctx,
    );
    assert.match(result.content[0].text, /A: Green/);
});

test("plan_ask degrades gracefully without a UI", async () => {
    const h = startHarness({ hasUI: false });
    const result = await h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx);
    assert.match(result.content[0].text, /require a UI session/i);
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

test("brainstorming keeps read-only built-ins and every whitelisted active tool", () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["mcp__browser__open", "mcp__docs__*"] });
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

test("brainstorming blocks all MCP tools by default", () => {
    const h = startHarness({ tools: ALL_TOOLS });
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
    for (const name of MCP_TOOLS) {
        assert.match(h.controller.blockReason(name) ?? "", /not available/i, name);
    }
});

test("brainstorming never activates a whitelisted tool that was inactive", () => {
    const h = startHarness({ tools: FULL_TOOLS, allowedTools: ["mcp__browser__*"] });
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
});

test("the allowlist accepts any tool name, not only MCP tools", () => {
    const h = startHarness({ tools: [...FULL_TOOLS, "task", "mcp__browser__open"], allowedTools: ["task"] });
    assert.ok(h.activeTools.includes("task"));
    assert.ok(!h.activeTools.includes("mcp__browser__open"));
    assert.equal(h.controller.blockReason("task"), undefined);
});

test("brainstorming blocks every tool outside the allowed set", () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["mcp__browser__*"] });
    for (const allowed of ["read", "grep", "ls", "find", "mcp__browser__open", "plan_propose"]) {
        assert.equal(h.controller.blockReason(allowed), undefined, allowed);
    }
    for (const blocked of ["bash", "edit", "write", "mcp__docs__search"]) {
        assert.match(h.controller.blockReason(blocked) ?? "", /not available/i, blocked);
    }
});

test("implementation enables every saved tool", () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "plan_complete"]);
});

test("implementation does not block tool calls", () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    assert.equal(h.controller.blockReason("bash"), undefined);
    assert.equal(h.controller.blockReason("mcp__docs__search"), undefined);
});

test("leaving plan mode drops the tools plan mode added and keeps later ones", async () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["mcp__browser__*"] });
    h.setActiveTools([...h.activeTools, "mcp__late__tool"]);
    await h.controller.command("disable", h.ctx);
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "mcp__late__tool"]);
});

test("accepting and completing restores the saved tools without the whitelisted tool", async () => {
    const h = startHarness({
        tools: ALL_TOOLS,
        allowedTools: ["mcp__browser__*"],
        choices: ["Accept and implement"],
    });
    assert.ok(h.activeTools.includes("mcp__browser__open"));
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "plan_complete"]);
    await h.controller.complete(h.ctx);
    assert.deepEqual(h.activeTools, ALL_TOOLS);
});

test("a tool that connects after startup is adopted, and only allowed ones stay active", async () => {
    const h = startHarness({ tools: FULL_TOOLS, allowedTools: ["mcp__docs__search"] });
    h.setActiveTools([...h.activeTools, "mcp__docs__search", "mcp__browser__open"]);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "mcp__docs__search", "plan_propose", "plan_ask"]);
    assert.equal(h.controller.blockReason("mcp__docs__search"), undefined);
    assert.match(h.controller.blockReason("mcp__browser__open") ?? "", /not available/i);
    await h.controller.command("disable", h.ctx);
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "mcp__docs__search", "mcp__browser__open"]);
});

test("an allowed tool is not blocked before the next sync", () => {
    const h = startHarness({ tools: FULL_TOOLS, allowedTools: ["mcp__docs__*"] });
    h.setActiveTools([...h.activeTools, "mcp__docs__search"]);
    assert.equal(h.controller.blockReason("mcp__docs__search"), undefined);
    assert.match(h.controller.blockReason("mcp__browser__open") ?? "", /not available/i);
});

test("syncing tools does nothing when the active set is already correct", () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["mcp__browser__*"] });
    const calls = h.setActiveToolsCalls;
    h.controller.beforeAgentStart("base", h.ctx);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.equal(h.setActiveToolsCalls, calls);
});

test("a tool that connects during implementation stays active and is restored", async () => {
    const h = startHarness({ data: { phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS } });
    h.setActiveTools([...h.activeTools, "mcp__docs__search"]);
    h.controller.beforeAgentStart("base", h.ctx);
    assert.ok(h.activeTools.includes("mcp__docs__search"));
    await h.controller.complete(h.ctx);
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "mcp__docs__search"]);
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
    const h = startHarness({ choices: ["Ask for review"] });
    await h.controller.propose(PROPOSAL, h.ctx);
    assert.equal(h.persisted[0].proposal, undefined);
    assert.deepEqual(h.persisted.at(-1)?.proposal, PROPOSAL);
    assert.notEqual(h.persisted[0], h.persisted.at(-1));
});

test("a bare wildcard in the allowlist never opens every tool", () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["*"] });
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
    assert.match(h.controller.blockReason("bash") ?? "", /not available/i);
});

test("resuming another branch restores that branch's phase and tools", () => {
    const h = startHarness({ tools: ALL_TOOLS, allowedTools: ["mcp__browser__*"] });
    h.controller.resume(h.ctx, { phase: "off", savedTools: [] });
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, ALL_TOOLS);
    h.controller.resume(h.ctx, { phase: "implementing", proposal: PROPOSAL, savedTools: [] });
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "plan_complete"]);
    h.controller.resume(h.ctx, { phase: "brainstorming", savedTools: [] });
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, [
        "read",
        "grep",
        "ls",
        "find",
        "mcp__browser__open",
        "mcp__browser__click",
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
