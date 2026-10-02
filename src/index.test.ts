import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import planMode from "./index.ts";
import type { PlanModeData, PlanProposal } from "./state.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const PROPOSAL: PlanProposal = {
    description: "Simplify the proposal flow so one tool handles submission and acceptance.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify orchestration and remove duplicate actions",
            example: 'planMode(pi, { allowedTools: ["mcp__browser__*"] })',
        },
    ],
};

interface Entry {
    type: string;
    customType: string;
    data: unknown;
}

interface RegisteredTool {
    name: string;
    description?: string;
    parameters: unknown;
    renderCall?: (
        args: unknown,
        theme: { fg: (role: string, text: string) => string; bold: (text: string) => string },
        context: { lastComponent?: unknown },
    ) => { setText(text: string): void };
    execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<unknown>;
}

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface HarnessOptions {
    entries?: Entry[];
    branch?: Entry[];
    tools?: string[];
    allowedTools?: string[];
    agentDir?: string;
    choices?: (string | undefined)[];
    loadPrompt?: (phase: string) => string | null;
    rejectStartupActions?: boolean;
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
    const notes: string[] = [];
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
            notify: (message: string) => void notes.push(message),
            select: async () => (options.choices ?? []).shift(),
            input: async () => undefined,
        },
        sessionManager: {
            getEntries: () => options.entries ?? options.branch ?? [],
            getBranch: () => options.branch ?? options.entries ?? [],
            getSessionId: () => "test-session",
            getSessionFile: () => undefined,
        },
    };

    planMode(pi as never, {
        loadPrompt: options.loadPrompt,
        allowedTools: options.allowedTools,
    });

    return {
        appended,
        displayEntries,
        notes,
        entryRenderers,
        start: () => {
            started = true;
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            process.env.PI_CODING_AGENT_DIR = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-plan-mode-agent-"));
            try {
                return events.get("session_start")!({}, ctx);
            } finally {
                if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
                else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            }
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

test("registers the plan control tools, command, and renderer", () => {
    const h = createHarness();
    for (const name of ["plan_propose", "plan_complete", "plan_ask"]) {
        assert.ok(h.toolDefinition(name), name);
    }
    assert.equal(h.toolDefinition("mcp__docs__search"), undefined);
    assert.ok(h.entryRenderers.has("plan-proposal"));
});

test("extension registration does not call runtime action methods", () => {
    const h = createHarness({ rejectStartupActions: true });
    h.start();
    assert.equal(h.status, "plan: brainstorming");
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

test("brainstorming blocks a disallowed tool through the tool_call event", () => {
    const h = createHarness({ tools: [...FULL_TOOLS, "mcp__docs__search"] });
    h.start();
    const result = h.emit("tool_call", { toolName: "mcp__docs__search" }) as
        { block?: boolean; reason?: string } | undefined;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /not available/i);
});

test("brainstorming allows read and a whitelisted active tool through the tool_call event", () => {
    const h = createHarness({ tools: [...FULL_TOOLS, "mcp__browser__open"], allowedTools: ["mcp__browser__*"] });
    h.start();
    assert.equal(h.emit("tool_call", { toolName: "read" }), undefined);
    assert.equal(h.emit("tool_call", { toolName: "mcp__browser__open" }), undefined);
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
    assert.equal(h.status, undefined);
});

test("prompt composition is turn-local system text", () => {
    const h = createHarness();
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result?.systemPrompt ?? "", /^base\n\n# Plan Mode/);
});

test("reads the allowed tools from ~/.pi/agent/plan.json", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-agent-"));
    writeFileSync(join(agentDir, "plan.json"), JSON.stringify({ allowedTools: ["mcp__docs__*"] }));
    const h = createHarness({
        agentDir,
        tools: [...FULL_TOOLS, "mcp__docs__search", "mcp__browser__open"],
    });
    h.start();
    assert.ok(h.activeTools.includes("mcp__docs__search"));
    assert.ok(!h.activeTools.includes("mcp__browser__open"));
});

test("merges the option and plan.json allowlists", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-agent-"));
    writeFileSync(join(agentDir, "plan.json"), JSON.stringify({ allowedTools: ["mcp__docs__search"] }));
    const h = createHarness({
        agentDir,
        allowedTools: ["mcp__browser__open"],
        tools: [...FULL_TOOLS, "mcp__docs__search", "mcp__browser__open"],
    });
    h.start();
    assert.ok(h.activeTools.includes("mcp__docs__search"));
    assert.ok(h.activeTools.includes("mcp__browser__open"));
});

test("reports a malformed plan.json and keeps only the builtins", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-agent-"));
    writeFileSync(join(agentDir, "plan.json"), "{ not json");
    const h = createHarness({ agentDir, tools: [...FULL_TOOLS, "mcp__docs__search"] });
    h.start();
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
    assert.ok(h.notes.some((note) => /plan\.json/.test(note)));
});

test("session_tree re-derives the plan phase from the new active branch", () => {
    const options: HarnessOptions = {
        branch: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    };
    const h = createHarness(options);
    h.start();
    assert.equal(h.status, "plan: implementing");
    options.branch = [entry({ phase: "brainstorming", savedTools: FULL_TOOLS })];
    h.emit("session_tree", {});
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
});

test("session_tree keeps the current state when the branch has no plan-mode entry", () => {
    const options: HarnessOptions = {
        branch: [entry({ phase: "implementing", proposal: PROPOSAL, savedTools: FULL_TOOLS })],
    };
    const h = createHarness(options);
    h.start();
    options.branch = [];
    h.emit("session_tree", {});
    assert.equal(h.status, "plan: implementing");
});

test("a restored off state removes stray plan control tools", () => {
    const h = createHarness({
        entries: [entry({ phase: "off", savedTools: FULL_TOOLS })],
        tools: [...FULL_TOOLS, "plan_propose", "plan_complete", "plan_ask"],
    });
    h.start();
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});
