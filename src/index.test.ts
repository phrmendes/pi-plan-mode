import { test } from "node:test";
import assert from "node:assert/strict";
import planMode from "./index.ts";
import { PLAN_PROPOSAL_SCHEMA, type PlanModeData, type PlanProposal } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const PROPOSAL: PlanProposal = {
    summary: "Improve flow",
    files: [{ path: "src/index.ts", reason: "Change orchestration" }],
    steps: [{ title: "Refactor", description: "Use control tools" }],
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
    const appended: PlanModeData[] = [];
    const sent: string[] = [];
    const notes: string[] = [];
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let status: string | undefined;
    let setActiveToolsCalls = 0;
    let selectCalls = 0;
    let started = false;

    const pi = {
        registerCommand: (name: string, definition: RegisteredCommand) => void commands.set(name, definition),
        registerTool: (definition: RegisteredTool) => void tools.set(definition.name, definition),
        on: (name: string, handler: EventHandler) => void events.set(name, handler),
        appendEntry: (_type: string, value: PlanModeData) => void appended.push(value),
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
                return (options.choices ?? []).shift();
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
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_propose"]);
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
    assert.match(result.systemPrompt, /^base\n\n# Brainstorming/);
    assert.equal(result.message, undefined);
});

test("plan_submit uses the durable proposal schema", () => {
    const h = createHarness();
    assert.equal(h.toolDefinition("plan_submit").parameters, PLAN_PROPOSAL_SCHEMA);
});

test("implementation prompt uses a compact proposal", () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result.systemPrompt, /Approved work: Improve flow/);
    assert.match(result.systemPrompt, /Refactor — Use control tools/);
    assert.doesNotMatch(result.systemPrompt, /Change orchestration/);
});

test("plan_propose enters planning without a synthetic user message", async () => {
    const h = createHarness();
    h.start();
    await h.tool("plan_propose");
    assert.equal(h.status, "plan: planning");
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_submit"]);
    assert.deepEqual(h.sent, []);
});

test("plan_submit approval enters persistent implementation", async () => {
    const h = createHarness({ choices: ["Implement now"] });
    h.start();
    await h.tool("plan_propose");
    await h.tool("plan_submit", PROPOSAL);
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, [...FULL_TOOLS, "plan_complete"]);
    assert.deepEqual(h.appended.at(-1)?.proposal, PROPOSAL);
});

test("plan_submit stores a proposal without UI approval", async () => {
    const h = createHarness({ hasUI: false });
    h.start();
    await h.tool("plan_propose");
    await h.tool("plan_submit", PROPOSAL);
    assert.equal(h.status, "plan: planning");
    assert.equal(h.selectCalls, 0);
    assert.deepEqual(h.appended.at(-1)?.proposal, PROPOSAL);
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_submit", "plan_approve"]);
});

test("plan_approve approves a stored proposal without resubmission", async () => {
    const h = createHarness({
        choices: ["Implement now"],
        entries: [entry({ phase: "planning", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.tool("plan_approve");
    assert.equal(h.status, "plan: implementing");
});

test("rejected proposal reports the actual outcome", async () => {
    const h = createHarness({ choices: ["Back to brainstorming"] });
    h.start();
    await h.tool("plan_propose");
    const result = await h.tool("plan_submit", PROPOSAL);
    assert.match(result.content[0].text, /rejected/i);
    assert.equal(h.appended.at(-1)?.proposal, undefined);
});

test("plan_complete returns to brainstorming and clears the proposal", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    await h.tool("plan_complete");
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.appended.at(-1)?.proposal, undefined);
    assert.deepEqual(h.activeTools, ["read", "bash", "plan_propose"]);
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
    await h.tool("plan_propose");
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
    assert.deepEqual(h.completions(), ["create", "disable"]);
    await h.command("create");
    assert.deepEqual(h.completions(), ["bstorm", "disable"]);
    await h.command("bstorm");
    assert.deepEqual(h.completions(), ["create", "disable"]);
});

test("create and bstorm commands enforce phase guards", async () => {
    const h = createHarness();
    h.start();
    await h.command("bstorm");
    assert.match(h.notes.at(-1) ?? "", /only in planning/i);
    await h.command("create");
    await h.command("create");
    assert.match(h.notes.at(-1) ?? "", /only in brainstorming/i);
});

test("create remains a synthetic-message fallback", async () => {
    const h = createHarness();
    h.start();
    await h.command("create");
    assert.deepEqual(h.sent, ["Draft and submit the formal proposal."]);
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

test("restores state from the active branch", () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
        branch: [entry({ phase: "planning", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    assert.equal(h.status, "plan: planning");
});

test("invalid control tool transition throws", async () => {
    const h = createHarness();
    h.start();
    await assert.rejects(h.tool("plan_complete"), /implementing/i);
});
