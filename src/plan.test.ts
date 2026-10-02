import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPlanController, formatProposal } from "./plan.ts";
import type { PlanModeData, PlanProposal, PlanState } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const MCP_TOOLS = ["mcp__agent_browser__open", "mcp__agent_browser__click", "mcp__nushell__evaluate"];
const ALL_TOOLS = [...FULL_TOOLS, ...MCP_TOOLS];
const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    problem: "The flow is hard to follow",
    outcome: "The proposal flow is clear",
    approach: "Use one proposal tool for submission and approval.",
    changes: [{ path: "src/index.ts", change: "Simplify orchestration and remove duplicate actions" }],
    acceptanceCriteria: ["One tool submits the proposal", "Transition tests pass"],
};

interface PlanHarnessOptions {
    tools?: string[];
    data?: PlanModeData;
    choices?: (string | undefined)[];
    inputs?: (string | undefined)[];
    hasUI?: boolean;
    loadPrompt?: (phase: PlanState) => string | null;
}

function createPlanHarness(options: PlanHarnessOptions = {}) {
    let activeTools = options.tools ?? [...FULL_TOOLS];
    const persisted: PlanModeData[] = [];
    const displays: unknown[] = [];
    const sent: string[] = [];
    const notes: string[] = [];
    let status: string | undefined;
    const choices = options.choices ?? [];
    const inputs = options.inputs ?? [];

    const controller = createPlanController({
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools) => {
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
        get activeTools() {
            return activeTools;
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

test("formatProposal renders every section of the proposal", () => {
    const markdown = formatProposal(PROPOSAL);
    assert.match(markdown, /^# Improve flow/);
    assert.match(markdown, /## Problem\nThe flow is hard to follow/);
    assert.match(markdown, /## Changes\n- `src\/index\.ts` — Simplify orchestration/);
    assert.match(markdown, /## Acceptance Criteria\n- One tool submits the proposal/);
});

test("fresh session enters brainstorming with the restricted tool set", () => {
    const h = startHarness();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
    assert.ok(!h.activeTools.includes("bash"));
    assert.ok(!h.activeTools.includes("edit"));
    assert.ok(!h.activeTools.includes("write"));
});

test("approval restores the saved tools and enables plan_complete", async () => {
    const h = startHarness({ choices: ["Approve and implement"] });
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
    assert.match(result.content[0].text, /# Improve flow/);
});

test("propose rejects placeholder content", async () => {
    const h = startHarness();
    await assert.rejects(h.controller.propose({ ...PROPOSAL, approach: "TBD" }, h.ctx), /placeholder/i);
});

test("propose accepts legitimate words that resemble placeholders", async () => {
    const h = startHarness();
    const proposal = { ...PROPOSAL, acceptanceCriteria: ["Handle unknown host names and CSV, JSON, etc."] };
    await h.controller.propose(proposal, h.ctx);
    assert.deepEqual(h.persisted.at(-1)?.proposal, proposal);
});

test("requesting revision clears the pending proposal and waits for feedback", async () => {
    const h = startHarness({ choices: ["Request revision"] });
    const result = await h.controller.propose(PROPOSAL, h.ctx);
    assert.match(result.content[0].text, /rejected/i);
    assert.equal(h.persisted.at(-1)?.proposal, undefined);
    assert.equal(h.status, "plan: waiting for feedback");
});

test("revision blocks new proposals and questions until user feedback", async () => {
    const h = startHarness({ choices: ["Request revision"] });
    await h.controller.propose(PROPOSAL, h.ctx);
    await assert.rejects(h.controller.propose(PROPOSAL, h.ctx), /feedback/i);
    await assert.rejects(h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx), /feedback/i);
    h.controller.handleInput("interactive", h.ctx);
    assert.equal(h.status, "plan: brainstorming");
    await h.controller.ask({ questions: [{ question: "q", options: ["a"] }] }, h.ctx);
});

test("deferring preserves the proposal for plan review", async () => {
    const h = startHarness({ choices: ["Keep for later", "Approve and implement"] });
    await h.controller.propose(PROPOSAL, h.ctx);
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
    assert.match(result?.systemPrompt ?? "", /# Improve flow/);
    assert.match(result?.systemPrompt ?? "", /## Problem\nThe flow is hard to follow/);
});

test("brainstorming keeps the read-only search tools and every agent-browser MCP tool", () => {
    const h = startHarness({ tools: ALL_TOOLS });
    assert.deepEqual(h.activeTools, [
        "read",
        "grep",
        "ls",
        "find",
        "mcp__agent_browser__open",
        "mcp__agent_browser__click",
        "plan_propose",
        "plan_ask",
    ]);
});

test("brainstorming excludes shell, editing, and nushell MCP tools", () => {
    const h = startHarness({ tools: ALL_TOOLS });
    for (const name of ["bash", "edit", "write", "mcp__nushell__evaluate"]) {
        assert.ok(!h.activeTools.includes(name), name);
    }
});

test("implementation enables every saved tool", () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    assert.deepEqual(h.activeTools, [...ALL_TOOLS, "plan_complete"]);
});

test("brainstorming blocks every tool outside the read and agent-browser allowlist", () => {
    const h = startHarness({ tools: ALL_TOOLS });
    for (const allowed of ["read", "grep", "ls", "find", "mcp__agent_browser__open", "plan_propose"]) {
        assert.equal(h.controller.blockReason(allowed), undefined, allowed);
    }
    assert.match(h.controller.blockReason("bash") ?? "", /not available/i);
    assert.match(h.controller.blockReason("edit") ?? "", /not available/i);
    assert.match(h.controller.blockReason("mcp__nushell__evaluate") ?? "", /not available/i);
});

test("implementation does not block tool calls", () => {
    const h = startHarness({
        data: { phase: "implementing", proposal: PROPOSAL, savedTools: ALL_TOOLS },
    });
    assert.equal(h.controller.blockReason("bash"), undefined);
    assert.equal(h.controller.blockReason("mcp__nushell__evaluate"), undefined);
});
