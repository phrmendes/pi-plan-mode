import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import planMode from "./index.ts";
import { PROPOSAL_ENTRY, type PlanProposal } from "./proposal.ts";
import type { PlanModeData, ThinkingLevel } from "./state.ts";

// This suite drives the real extension, so keep it off the desktop notification bus.
process.env.PI_PLAN_NOTIFY = "off";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const PROPOSAL: PlanProposal = {
    description: "Simplify the proposal flow so one tool handles submission and acceptance.",
    changes: [
        {
            path: "src/index.ts",
            change: "Simplify orchestration and remove duplicate actions",
            example: '"deniedTools": ["mcp__browser__*"]',
        },
    ],
};

interface ModelRef {
    provider: string;
    id: string;
}

interface Entry {
    type: string;
    customType: string;
    data: unknown;
}

interface RegisteredTool {
    name: string;
    exposure?: string;
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
    plan?: unknown;
    model?: ModelRef;
    registry?: ModelRef[];
    agentDir?: string;
    cwd?: string;
    trusted?: boolean;
    choices?: (string | undefined)[];
    rejectStartupActions?: boolean;
}

function entry(data: unknown): Entry {
    return { type: "custom", customType: "plan-mode", data };
}

function createHarness(options: HarnessOptions = {}) {
    const events = new Map<string, EventHandler>();
    const commands = new Map<
        string,
        { handler(args: string, ctx: unknown): unknown; getArgumentCompletions(prefix: string): unknown }
    >();
    const tools = new Map<string, RegisteredTool>();
    const entryRenderers = new Map<string, unknown>();
    const appended: PlanModeData[] = [];
    const displayEntries: unknown[] = [];
    const notes: string[] = [];
    let activeTools = options.tools ?? [...FULL_TOOLS];
    let status: string | undefined;
    let setActiveToolsCalls = 0;
    let started = false;
    const modelCalls: ModelRef[] = [];
    const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "pi-plan-mode-cwd-"));
    const trusted = options.trusted ?? true;
    let thinkingLevel: ThinkingLevel = "medium";

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
        setModel: async (model: ModelRef) => {
            const previous = ctx.model;
            modelCalls.push(model);
            ctx.model = model;
            events.get("model_select")?.({ type: "model_select", model, previousModel: previous, source: "set" }, ctx);
            return true;
        },
        getThinkingLevel: () => thinkingLevel,
        setThinkingLevel: (level: ThinkingLevel) => {
            const previous = thinkingLevel;
            thinkingLevel = level;
            events.get("thinking_level_select")?.(
                { type: "thinking_level_select", level, previousLevel: previous },
                ctx,
            );
        },
    };

    const ctx = {
        hasUI: true,
        model: options.model,
        isProjectTrusted: () => trusted,
        modelRegistry: {
            find: (provider: string, id: string) =>
                (options.registry ?? []).find((model) => model.provider === provider && model.id === id),
        },
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
            getCwd: () => cwd,
        },
    };

    planMode(pi as never);

    return {
        appended,
        modelCalls,
        displayEntries,
        notes,
        entryRenderers,
        start: () => {
            started = true;
            const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
            const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-plan-mode-agent-"));
            if (options.plan !== undefined) {
                const contents = typeof options.plan === "string" ? options.plan : JSON.stringify(options.plan);
                writeFileSync(join(agentDir, "plan.json"), contents);
            }
            process.env.PI_CODING_AGENT_DIR = agentDir;
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
        plan: (args: string) => commands.get("plan")!.handler(args, ctx),
        planCompletions: (prefix: string) => commands.get("plan")!.getArgumentCompletions(prefix),
        beforeAgentStart: (systemPrompt = "base") =>
            events.get("before_agent_start")!({ systemPrompt }, ctx) as { systemPrompt: string } | undefined,
        get activeTools() {
            return activeTools;
        },
        get model() {
            return ctx.model;
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
    assert.ok(h.entryRenderers.has("plan-proposal"));
});

test("the plan control tools are model-only, so codemode scripts cannot call them", () => {
    const h = createHarness();
    for (const name of ["plan_propose", "plan_complete", "plan_ask"]) {
        assert.equal(h.toolDefinition(name).exposure, "model-only", name);
    }
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

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

test("brainstorming blocks a default denied tool through the tool_call event", () => {
    const h = createHarness();
    h.start();
    const result = h.emit("tool_call", { toolName: "edit" }) as ToolCallResult;
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /not available/i);
});

test("brainstorming allows read and a tool that is not denied through the tool_call event", () => {
    const h = createHarness({ tools: [...FULL_TOOLS, "mcp__browser__open"] });
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
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "plan_propose", "plan_ask"]);
});

test("prompt composition is turn-local system text", () => {
    const h = createHarness();
    h.start();
    const result = h.beforeAgentStart();
    assert.match(result?.systemPrompt ?? "", /^base\n\n# Plan Mode/);
});

test("reads the deny list from ~/.pi/agent/plan.json", () => {
    const h = createHarness({
        plan: { modes: { brainstorming: { deniedTools: ["mcp__browser__*"] } } },
        tools: [...FULL_TOOLS, "mcp__docs__search", "mcp__browser__open"],
    });
    h.start();
    assert.ok(h.activeTools.includes("mcp__docs__search"));
    assert.ok(!h.activeTools.includes("mcp__browser__open"));
});

test("reports a malformed plan.json and denies only the defaults", () => {
    const h = createHarness({ plan: "{ not json", tools: [...FULL_TOOLS, "mcp__docs__search"] });
    h.start();
    assert.deepEqual(h.activeTools, ["read", "grep", "ls", "find", "mcp__docs__search", "plan_propose", "plan_ask"]);
    assert.ok(h.notes.some((note) => /plan\.json/.test(note)));
});

test("switches to the plan.json model of a phase through pi.setModel", async () => {
    const h = createHarness({
        plan: { modes: { brainstorming: { model: "bifrost-openai/Huawei/deepseek-v4-pro" } } },
        model: { provider: "deepseek", id: "deepseek-flash" },
        registry: [{ provider: "bifrost-openai", id: "Huawei/deepseek-v4-pro" }],
    });
    await h.start();
    assert.deepEqual(h.modelCalls, [{ provider: "bifrost-openai", id: "Huawei/deepseek-v4-pro" }]);
    assert.equal(h.appended.at(-1)?.savedModel, "deepseek/deepseek-flash");
});

test("a model missing from the registry warns without calling pi.setModel", async () => {
    const h = createHarness({
        plan: { modes: { brainstorming: { model: "p/missing" } } },
        model: { provider: "deepseek", id: "deepseek-flash" },
    });
    await h.start();
    assert.deepEqual(h.modelCalls, []);
    assert.ok(h.notes.some((note) => /cannot switch to the model "p\/missing"/.test(note)));
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

test("the proposal renderer shows the stored markdown and survives a broken entry", () => {
    initTheme("dark");
    const h = createHarness();
    const renderer = h.entryRenderers.get(PROPOSAL_ENTRY) as (entry: { data?: unknown }) => {
        render(width: number): string[];
    };
    const plainText = (data: unknown) =>
        renderer({ data })
            .render(60)
            .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
            .join("\n")
            .trim();
    assert.match(plainText({ markdown: "## Description\nShip the deny list" }), /Ship the deny list/);
    assert.equal(plainText({ markdown: 42 }), "");
    assert.equal(plainText(undefined), "");
});

test("the /plan command and its completions reach the controller", async () => {
    const h = createHarness();
    h.start();
    assert.deepEqual(
        (h.planCompletions("of") as Array<{ value: string }>).map((item) => item.value),
        ["off"],
    );
    await h.plan("off");
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("the plan_ask tool returns the user's answers", async () => {
    const h = createHarness({ choices: ["Blue"] });
    h.start();
    const result = (await h.tool("plan_ask", {
        questions: [{ question: "Favorite color?", options: ["Blue", "Red"] }],
    })) as { content: Array<{ text: string }> };
    assert.match(result.content[0]?.text ?? "", /Q: Favorite color\?\nA: Blue/);
});

test("a user model change is captured as an override", () => {
    const h = createHarness();
    h.start();
    h.emit("model_select", {
        type: "model_select",
        model: { provider: "p", id: "custom" },
        previousModel: undefined,
        source: "set",
    });
    assert.equal(h.appended.at(-1)?.overrides?.default?.brainstorming?.model, "p/custom");
});

test("a restored model change is not captured", () => {
    const h = createHarness();
    h.start();
    const before = h.appended.length;
    h.emit("model_select", {
        type: "model_select",
        model: { provider: "p", id: "custom" },
        previousModel: undefined,
        source: "restore",
    });
    assert.equal(h.appended.length, before);
});

test("plan mode's own model switch is not captured as an override", () => {
    const h = createHarness({
        plan: { modes: { brainstorming: { model: "p/plan" } } },
        registry: [{ provider: "p", id: "plan" }],
    });
    h.start();
    assert.deepEqual(h.modelCalls, [{ provider: "p", id: "plan" }]);
    assert.equal(
        h.appended.some((entry) => entry.overrides !== undefined),
        false,
    );
});

test("a thinking level change is captured as an override", () => {
    const h = createHarness();
    h.start();
    h.emit("thinking_level_select", { type: "thinking_level_select", level: "max", previousLevel: "medium" });
    assert.equal(h.appended.at(-1)?.overrides?.default?.brainstorming?.thinkingLevel, "max");
});

test("a trusted project reads .plan.json and an untrusted one ignores it", () => {
    const project = mkdtempSync(join(tmpdir(), "pi-plan-mode-project-"));
    writeFileSync(join(project, ".git"), "");
    writeFileSync(
        join(project, ".plan.json"),
        JSON.stringify({ activeProfile: "work", profiles: { work: { brainstorming: { model: "p/local" } } } }),
    );
    const trustedHarness = createHarness({
        cwd: project,
        model: { provider: "p", id: "user" },
        registry: [{ provider: "p", id: "local" }],
    });
    trustedHarness.start();
    assert.deepEqual(trustedHarness.modelCalls, [{ provider: "p", id: "local" }]);

    const untrustedHarness = createHarness({
        cwd: project,
        trusted: false,
        model: { provider: "p", id: "user" },
        registry: [{ provider: "p", id: "local" }],
    });
    untrustedHarness.start();
    assert.deepEqual(untrustedHarness.modelCalls, []);
});
