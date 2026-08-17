import { test } from "node:test";
import assert from "node:assert/strict";
import planMode from "./index.ts";
import { PLAN_PROPOSAL_SCHEMA, type PlanModeData, type PlanProposal } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const PROPOSAL: PlanProposal = {
    title: "Improve flow",
    problem: "The flow is hard to follow",
    outcome: "The proposal flow is clear",
    approach: "Use one proposal tool for submission and approval.",
    changes: [{ path: "src/index.ts", change: "Simplify orchestration and remove duplicate actions" }],
    acceptanceCriteria: ["One tool submits the proposal", "Transition tests pass"],
};

interface Entry {
    type: string;
    customType: string;
    data: unknown;
}

interface Completion {
    value: string;
}

interface RegisteredCommand {
    handler(args: string, ctx: unknown): Promise<void> | void;
    getArgumentCompletions(prefix: string): Completion[] | null;
}

interface ToolResult {
    content: Array<{ type: string; text: string }>;
    details: unknown;
}

interface RegisteredTool {
    name: string;
    parameters: unknown;
    execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<ToolResult>;
}

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface HarnessOptions {
    entries?: Entry[];
    branch?: Entry[];
    tools?: string[];
    choices?: (string | undefined)[];
    inputs?: (string | undefined)[];
    hasUI?: boolean;
    loadPrompt?: (phase: string) => string | null;
    rejectStartupActions?: boolean;
}

function entry(data: unknown): Entry {
    return { type: "custom", customType: "plan-mode", data };
}

/** Drives the extension through stubbed pi and context APIs. */
function createHarness(options: HarnessOptions = {}) {
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, RegisteredCommand>();
    const tools = new Map<string, RegisteredTool>();
    const entryRenderers = new Map<string, unknown>();
    const appended: PlanModeData[] = [];
    const displayEntries: unknown[] = [];
    const sent: string[] = [];
    const notes: string[] = [];
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let status: string | undefined;
    let setActiveToolsCalls = 0;
    let selectCalls = 0;
    let inputCalls = 0;
    let displayEntriesAtSelect = 0;
    let started = false;

    const pi = {
        registerCommand: (name: string, definition: RegisteredCommand) => void commands.set(name, definition),
        registerTool: (definition: RegisteredTool) => void tools.set(definition.name, definition),
        registerEntryRenderer: (type: string, renderer: unknown) => void entryRenderers.set(type, renderer),
        on: (name: string, handler: EventHandler) => void events.set(name, handler),
        appendEntry: (type: string, value: PlanModeData) => {
            if (type === "plan-mode") appended.push(value);
            else displayEntries.push(value);
        },
        sendUserMessage: (message: string) => void sent.push(message),
        getActiveTools: () => {
            if (options.rejectStartupActions && !started) throw new Error("Extension runtime not initialized");
            return [...activeTools];
        },
        setActiveTools: (names: string[]) => {
            setActiveToolsCalls++;
            activeTools = [...names];
        },
    };
    const ctx = {
        hasUI: options.hasUI ?? true,
        ui: {
            setStatus: (_key: string, value?: string) => void (status = value),
            notify: (message: string) => void notes.push(message),
            select: async () => {
                selectCalls++;
                displayEntriesAtSelect = displayEntries.length;
                return (options.choices ?? []).shift();
            },
            input: async () => {
                inputCalls++;
                return (options.inputs ?? []).shift();
            },
        },
        sessionManager: {
            getEntries: () => options.entries ?? options.branch ?? [],
            getBranch: () => options.branch ?? options.entries ?? [],
        },
    };

    planMode(pi as unknown as Parameters<typeof planMode>[0], { loadPrompt: options.loadPrompt });

    return {
        appended,
        displayEntries,
        entryRenderers,
        sent,
        notes,
        start: () => {
            started = true;
            return events.get("session_start")!({}, ctx);
        },
        command: (args = "") => commands.get("plan")!.handler(args, ctx),
        completions: (prefix = "") =>
            commands
                .get("plan")!
                .getArgumentCompletions(prefix)
                ?.map((item) => item.value) ?? [],
        tool: (name: string, input: unknown = {}, id = "id") =>
            tools.get(name)!.execute(id, input, undefined, undefined, ctx),
        toolDefinition: (name: string) => tools.get(name)!,
        emit: (name: string, event: unknown = {}) => events.get(name)?.(event, ctx),
        toolCall: (toolName: string, command: string) =>
            events.get("tool_call")?.({ toolName, input: { command } }, ctx) as { block?: boolean } | undefined,
        beforeAgentStart: (systemPrompt = "base") =>
            events.get("before_agent_start")!({ systemPrompt }, ctx) as {
                systemPrompt: string;
                message?: unknown;
            },
        get activeTools() {
            return activeTools;
        },
        get status() {
            return status;
        },
        get setActiveToolsCalls() {
            return setActiveToolsCalls;
        },
        get selectCalls() {
            return selectCalls;
        },
        get inputCalls() {
            return inputCalls;
        },
        get displayEntriesAtSelect() {
            return displayEntriesAtSelect;
        },
    };
}

test("extension registration does not call runtime action methods", () => {
    const h = createHarness({ rejectStartupActions: true });
    h.start();
    assert.equal(h.status, "plan: brainstorming");
});

test("fresh session enters brainstorming with the agent transition tool", () => {
    const h = createHarness();
    h.start();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_propose", "plan_ask"]);
});

test("fresh session snapshots the complete active tool set, not a partial one", async () => {
    const dynamicTools = [...FULL_TOOLS, "dynamic-tool"];
    const h = createHarness({ tools: dynamicTools, choices: ["Approve and implement"] });
    h.start();
    await h.tool("plan_propose", PROPOSAL);
    assert.deepEqual(h.activeTools, [...dynamicTools, "plan_complete"]);
});

test("restored off state does not change tools", () => {
    const h = createHarness({
        entries: [entry({ phase: "off", savedTools: FULL_TOOLS })],
        tools: ["read", "custom"],
    });
    h.start();
    assert.deepEqual(h.activeTools, ["read", "custom"]);
    assert.equal(h.setActiveToolsCalls, 0);
});

test("phase prompt is turn-local system text", () => {
    const h = createHarness();
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result.systemPrompt, /^base\n\n# Plan Mode/);
    assert.equal(result.message, undefined);
});

test("plan_propose uses the durable proposal schema", () => {
    const h = createHarness();
    assert.equal(h.toolDefinition("plan_propose").parameters, PLAN_PROPOSAL_SCHEMA);
});

test("implementation prompt renders the full PRD", () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result.systemPrompt, /# Improve flow/);
    assert.match(result.systemPrompt, /## Problem\nThe flow is hard to follow/);
    assert.doesNotMatch(result.systemPrompt, /## Goals/);
    assert.match(result.systemPrompt, /Simplify orchestration/);
    assert.match(result.systemPrompt, /Transition tests pass/);
});

test("plan_propose shows one canonical proposal and enters implementation after approval", async () => {
    const h = createHarness({ choices: ["Approve and implement"] });
    h.start();
    await h.tool("plan_propose", PROPOSAL);
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "plan_complete"]);
    assert.deepEqual(h.appended.at(-1)?.proposal, PROPOSAL);
    assert.equal(h.displayEntries.length, 1);
    const display = h.displayEntries[0] as { markdown: string };
    assert.match(display.markdown, /# Improve flow/);
    assert.match(display.markdown, /Transition tests pass/);
    assert.equal(h.displayEntriesAtSelect, 1);
    assert.ok(h.notes.every((note) => !note.includes("# Improve flow")));
    assert.ok(h.entryRenderers.has("plan-proposal"));
    assert.deepEqual(h.sent, []);
});

test("plan_propose stores and returns the formatted proposal without UI", async () => {
    const h = createHarness({ hasUI: false });
    h.start();
    const result = await h.tool("plan_propose", PROPOSAL);
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.selectCalls, 0);
    assert.deepEqual(h.appended.at(-1)?.proposal, PROPOSAL);
    assert.match(result.content[0].text, /# Improve flow/);
});

test("plan_propose rejects placeholder content", async () => {
    const h = createHarness();
    h.start();
    await assert.rejects(h.tool("plan_propose", { ...PROPOSAL, approach: "TBD" }), /placeholder/i);
    assert.equal(h.selectCalls, 0);
});

test("requesting revision clears the pending proposal", async () => {
    const h = createHarness({ choices: ["Request revision"] });
    h.start();
    const result = await h.tool("plan_propose", PROPOSAL);
    assert.match(result.content[0].text, /revision/i);
    assert.equal(h.appended.at(-1)?.proposal, undefined);
    assert.equal(h.status, "plan: brainstorming");
});

test("deferring preserves the proposal for plan review", async () => {
    const h = createHarness({ choices: ["Keep for later", "Approve and implement"] });
    h.start();
    await h.tool("plan_propose", PROPOSAL);
    assert.deepEqual(h.appended.at(-1)?.proposal, PROPOSAL);
    await h.command("review");
    assert.equal(h.status, "plan: implementing");
});

test("plan_complete returns to brainstorming and clears the proposal", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.tool("plan_complete");
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.appended.at(-1)?.proposal, undefined);
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_propose", "plan_ask"]);
});

test("implementation remains active across agent lifecycle events", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("agent_end", { messages: [] });
    await h.emit("agent_settled");
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "plan_complete"]);
});

test("agent_settled reminds the agent to call plan_complete once, when idle mid-implementation", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("agent_settled");
    assert.deepEqual(h.sent, [
        "If every acceptance criterion is verified, call plan_complete now. If not, continue implementing.",
    ]);
    await h.emit("agent_settled");
    assert.equal(h.sent.length, 1);
});

test("agent_settled does not remind while implementation tools are in flight", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit" });
    await h.emit("agent_settled");
    assert.deepEqual(h.sent, []);
    await h.emit("tool_execution_end", { toolCallId: "edit-1", toolName: "edit" });
    await h.emit("agent_settled");
    assert.equal(h.sent.length, 1);
});

test("agent_settled reminder resets after a new proposal is approved", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
        choices: ["Approve and implement"],
    });
    h.start();
    await h.emit("agent_settled");
    assert.equal(h.sent.length, 1);
    await h.tool("plan_complete");
    await h.tool("plan_propose", PROPOSAL);
    await h.emit("agent_settled");
    assert.equal(h.sent.length, 2);
});

test("plan_complete waits for implementation tools to finish", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit" });
    await assert.rejects(h.tool("plan_complete"), /after all implementation tools finish/i);
    await h.emit("tool_execution_end", { toolCallId: "edit-1", toolName: "edit" });
    await h.tool("plan_complete");
    assert.equal(h.status, "plan: brainstorming");
});

test("plan_complete stays blocked while multiple implementation tools are in flight", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit" });
    await h.emit("tool_execution_start", { toolCallId: "write-1", toolName: "write" });
    await assert.rejects(h.tool("plan_complete"), /after all implementation tools finish/i);
    await h.emit("tool_execution_end", { toolCallId: "edit-1", toolName: "edit" });
    await assert.rejects(h.tool("plan_complete"), /after all implementation tools finish/i);
    await h.emit("tool_execution_end", { toolCallId: "write-1", toolName: "write" });
    await h.tool("plan_complete");
    assert.equal(h.status, "plan: brainstorming");
});

test("session shutdown restores the saved tool set", async () => {
    const h = createHarness();
    h.start();
    await h.emit("session_shutdown", { reason: "new" });
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("bash gate is wired to read-only phases", async () => {
    const h = createHarness();
    h.start();
    assert.equal(h.toolCall("bash", "rm -rf /")?.block, true);
    const implementation = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    implementation.start();
    assert.equal(implementation.toolCall("bash", "rm -rf /"), undefined);
});

test("command completions follow the current phase", async () => {
    const h = createHarness({ entries: [entry({ phase: "off", savedTools: FULL_TOOLS })] });
    h.start();
    assert.deepEqual(h.completions(), []);
    await h.command();
    assert.deepEqual(h.completions(), ["review", "disable"]);
});

test("review reports when no proposal is stored", async () => {
    const h = createHarness();
    h.start();
    await h.command("review");
    assert.match(h.notes.at(-1) ?? "", /no stored proposal/i);
});

test("disable is available only while plan mode is enabled", async () => {
    const h = createHarness();
    h.start();
    await h.command("disable");
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    await h.command("disable");
    assert.match(h.notes.at(-1) ?? "", /already disabled/i);
});

test("disable is blocked while implementation tools are in flight", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit" });
    await h.command("disable");
    assert.equal(h.status, "plan: implementing");
    assert.match(h.notes.at(-1) ?? "", /wait for implementation tools/i);
    await h.emit("tool_execution_end", { toolCallId: "edit-1", toolName: "edit" });
    await h.command("disable");
    assert.equal(h.status, undefined);
});

test("restores state from the active branch", () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
        branch: [
            entry({ phase: "brainstorming", proposal: PROPOSAL, savedTools: FULL_TOOLS }),
            { type: "custom", customType: "plan-proposal", data: { markdown: "# Display only" } },
        ],
    });
    h.start();
    assert.equal(h.status, "plan: brainstorming");
});

test("invalid control tool transition throws", async () => {
    const h = createHarness();
    h.start();
    await assert.rejects(h.tool("plan_complete"), /implementing/i);
});

test("plan_ask is available in brainstorming but not implementing", async () => {
    const h = createHarness();
    h.start();
    assert.ok(h.activeTools.includes("plan_ask"));

    const implementation = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    implementation.start();
    assert.ok(!implementation.activeTools.includes("plan_ask"));
    await assert.rejects(
        implementation.tool("plan_ask", { questions: [{ question: "q", options: ["a"] }] }),
        /brainstorming/i,
    );
});

test("plan_ask returns a selected option as the answer", async () => {
    const h = createHarness({ choices: ["Blue"] });
    h.start();
    const result = await h.tool("plan_ask", { questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }] });
    assert.match(result.content[0].text, /Q: Favorite color\?\nA: Blue/);
    assert.equal(h.inputCalls, 0);
});

test("plan_ask falls back to free text when the user picks Other", async () => {
    const h = createHarness({ choices: ["Other (type your own)"], inputs: ["Green"] });
    h.start();
    const result = await h.tool("plan_ask", { questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }] });
    assert.match(result.content[0].text, /Q: Favorite color\?\nA: Green/);
    assert.equal(h.inputCalls, 1);
});

test("plan_ask asks every question and joins the answers", async () => {
    const h = createHarness({ choices: ["Blue", "Red"] });
    h.start();
    const result = await h.tool("plan_ask", {
        questions: [
            { question: "Favorite color?", options: ["Blue", "Green"] },
            { question: "Favorite fruit?", options: ["Red", "Yellow"] },
        ],
    });
    assert.match(result.content[0].text, /Q: Favorite color\?\nA: Blue\n\nQ: Favorite fruit\?\nA: Red/);
});

test("plan_ask degrades gracefully without a UI", async () => {
    const h = createHarness({ hasUI: false });
    h.start();
    const result = await h.tool("plan_ask", { questions: [{ question: "q", options: ["a"] }] });
    assert.match(result.content[0].text, /require a UI session/i);
    assert.equal(h.selectCalls, 0);
    assert.equal(h.inputCalls, 0);
});
