import { test } from "node:test";
import assert from "node:assert/strict";
import planMode from "./index.ts";
import { PLAN_PROPOSAL_SCHEMA, type PlanModeData, type PlanProposal } from "./state.ts";
import type { NushellProcessResult } from "./nushell.ts";

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

interface RegisteredTool {
    name: string;
    parameters: unknown;
    execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<unknown>;
}

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface HarnessOptions {
    entries?: Entry[];
    branch?: Entry[];
    tools?: string[];
    choices?: (string | undefined)[];
    loadPrompt?: (phase: string) => string | null;
    rejectStartupActions?: boolean;
    nushellRunner?: (command: string) => Promise<NushellProcessResult>;
}

function entry(data: unknown): Entry {
    return { type: "custom", customType: "plan-mode", data };
}

function createHarness(options: HarnessOptions = {}) {
    const events = new Map<string, EventHandler>();
    const commands = new Map<string, { handler(args: string, ctx: unknown): unknown }>();
    const tools = new Map<string, RegisteredTool>();
    const entryRenderers = new Map<string, unknown>();
    const appended: PlanModeData[] = [];
    const displayEntries: unknown[] = [];
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let status: string | undefined;
    let setActiveToolsCalls = 0;
    let started = false;

    const pi = {
        registerCommand: (name: string, definition: unknown) => void commands.set(name, definition as never),
        registerTool: (definition: RegisteredTool) => void tools.set(definition.name, definition),
        registerEntryRenderer: (type: string, renderer: unknown) => void entryRenderers.set(type, renderer),
        on: (name: string, handler: EventHandler) => void events.set(name, handler),
        appendEntry: (type: string, value: PlanModeData | unknown) => {
            if (type === "plan-mode") appended.push(value as PlanModeData);
            else displayEntries.push(value);
        },
        sendUserMessage: () => {},
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
        hasUI: true,
        ui: {
            setStatus: (_key: string, value?: string) => void (status = value),
            notify: () => {},
            select: async () => (options.choices ?? []).shift(),
            input: async () => undefined,
        },
        sessionManager: {
            getEntries: () => options.entries ?? options.branch ?? [],
            getBranch: () => options.branch ?? options.entries ?? [],
        },
    };

    planMode(pi as never, {
        loadPrompt: options.loadPrompt,
        nushellRunner: options.nushellRunner ?? (async () => ({ stdout: "ran", stderr: "", exitCode: 0 })),
    });

    return {
        appended,
        displayEntries,
        entryRenderers,
        start: () => {
            started = true;
            return events.get("session_start")!({}, ctx);
        },
        tool: (name: string, input: unknown = {}, id = "id") =>
            tools.get(name)!.execute(id, input, undefined, undefined, ctx),
        toolDefinition: (name: string) => tools.get(name)!,
        emit: (name: string, event: unknown = {}) => events.get(name)?.(event, ctx),
        beforeAgentStart: (systemPrompt = "base") =>
            events.get("before_agent_start")!({ systemPrompt }, ctx) as { systemPrompt: string } | undefined,
        get activeTools() {
            return activeTools;
        },
        get status() {
            return status;
        },
        get setActiveToolsCalls() {
            return setActiveToolsCalls;
        },
    };
}

test("registers the plan control tools, nushell tool, command, and renderer", () => {
    const h = createHarness();
    for (const name of ["nushell", "plan_propose", "plan_complete", "plan_ask"]) {
        assert.ok(h.toolDefinition(name), name);
    }
    assert.ok(h.entryRenderers.has("plan-proposal"));
});

test("plan_propose uses the durable proposal schema", () => {
    const h = createHarness();
    assert.equal(h.toolDefinition("plan_propose").parameters, PLAN_PROPOSAL_SCHEMA);
});

test("extension registration does not call runtime action methods", () => {
    const h = createHarness({ rejectStartupActions: true });
    h.start();
    assert.equal(h.status, "plan: brainstorming");
});

test("fresh session enters brainstorming with nushell instead of bash", () => {
    const h = createHarness();
    h.start();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "nushell", "plan_propose", "plan_ask"]);
    assert.ok(!h.activeTools.includes("bash"));
});

test("implementation restores non-shell tools and excludes bash", async () => {
    const dynamicTools = [...FULL_TOOLS, "dynamic-tool"];
    const h = createHarness({ tools: dynamicTools, choices: ["Approve and implement"] });
    h.start();
    await h.tool("plan_propose", PROPOSAL);
    assert.deepEqual(h.activeTools, ["read", "edit", "write", "dynamic-tool", "nushell", "plan_complete"]);
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

test("session shutdown restores the saved tool set", async () => {
    const h = createHarness();
    h.start();
    await h.emit("session_shutdown", { reason: "new" });
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("restores state from the active branch", () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
        branch: [entry({ phase: "brainstorming", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    assert.equal(h.status, "plan: brainstorming");
});

test("nushell tool blocks mutations during brainstorming", async () => {
    const h = createHarness();
    h.start();
    await assert.rejects(h.tool("nushell", { command: "ls | save report.txt" }), /blocked/i);
});

test("nushell tool runs allowed planning commands through the runner", async () => {
    const h = createHarness();
    h.start();
    const result = (await h.tool("nushell", { command: "open package.json | get scripts" })) as {
        content: Array<{ text: string }>;
    };
    assert.equal(result.content[0].text, "ran");
});

test("nushell tool runs unrestricted commands during implementation", async () => {
    const calls: string[] = [];
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
        nushellRunner: async (command) => {
            calls.push(command);
            return { stdout: "", stderr: "", exitCode: 0 };
        },
    });
    h.start();
    const result = (await h.tool("nushell", { command: "rm -r build" })) as {
        content: Array<{ text: string }>;
    };
    assert.equal(result.content[0].text, "(no output)");
    assert.deepEqual(calls, ["rm -r build"]);
});

test("tool lifecycle events are wired to implementation tracking", async () => {
    const h = createHarness({
        entries: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    });
    h.start();
    h.emit("tool_execution_start", { toolCallId: "edit-1", toolName: "edit" });
    await assert.rejects(h.tool("plan_complete"), /after all implementation tools finish/i);
    h.emit("tool_execution_end", { toolCallId: "edit-1", toolName: "edit" });
    await h.tool("plan_complete");
    assert.equal(h.status, "plan: brainstorming");
});

test("prompt composition is turn-local system text", () => {
    const h = createHarness();
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result?.systemPrompt ?? "", /^base\n\n# Plan Mode/);
});
