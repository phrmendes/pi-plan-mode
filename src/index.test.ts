import { test } from "node:test";
import assert from "node:assert/strict";
import planMode from "./index.ts";

const FULL_TOOLS = ["read", "bash", "edit", "write"];
const READ_ONLY_TOOLS = ["read", "bash"];

const PLAN_MD = "### Steps\n\n1. **First step** — do a thing\n2. **Second step** — do another\n";

interface Entry {
    type: string;
    customType: string;
    data: unknown;
}

function entry(data: unknown): Entry {
    return { type: "custom", customType: "plan-mode", data };
}

function assistantMsg(text: string): unknown {
    return { role: "assistant", content: [{ type: "text", text }] };
}

interface HarnessOpts {
    entries?: Entry[];
    tools?: string[];
    selectChoices?: (string | undefined)[];
    /** When true, sendUserMessage with followUp queues instead of starting a turn directly. */
    streaming?: boolean;
}

/**
 * Drives the real extension through a stubbed pi/ctx.
 * `selectChoices` is the canned approval-dialog answer; undefined simulates Esc.
 */
function createHarness(opts: HarnessOpts = {}) {
    const events = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
    let activeTools = opts.tools ?? [...FULL_TOOLS];
    const appended: Array<{ state?: string; creating?: boolean; steps?: unknown[] }> = [];
    const sent: string[] = [];
    const sentOpts: Array<{ deliverAs?: string } | undefined> = [];
    const notes: string[] = [];
    let status: string | undefined;
    const statuses: Array<string | undefined> = [];
    let selectCalls = 0;
    const streaming = opts.streaming ?? false;
    const followUpQueue: Array<{ msg: string; opts?: { deliverAs?: string } }> = [];

    const pi = {
        registerCommand: (name: string, def: any) => void commands.set(name, def),
        on: (event: string, fn: any) => void events.set(event, fn),
        appendEntry: (_type: string, data: any) => void appended.push(data),
        sendUserMessage: (msg: string, opts?: { deliverAs?: string }) => {
            sent.push(msg);
            sentOpts.push(opts);
            if (streaming && opts?.deliverAs === "followUp") {
                followUpQueue.push({ msg, opts });
            }
        },
        getActiveTools: () => [...activeTools],
        setActiveTools: (tools: string[]) => {
            activeTools = [...tools];
        },
    };
    const ctx = {
        hasUI: true,
        ui: {
            setStatus: (_key: string, value?: string) => {
                status = value;
                statuses.push(value);
            },
            notify: (msg: string) => void notes.push(msg),
            select: async () => {
                selectCalls++;
                return (opts.selectChoices ?? []).shift();
            },
        },
        sessionManager: { getEntries: () => opts.entries ?? [] },
    };

    planMode(pi as any);

    return {
        sent,
        sentOpts,
        notes,
        appended,
        start: () => events.get("session_start")!({}, ctx),
        command: (args: string) => commands.get("plan")!.handler(args, ctx),
        agentEnd: (messages: unknown[] = []) => events.get("agent_end")!({ messages }, ctx),
        beforeAgentStart: () => {
            const home = process.env.HOME;
            process.env.HOME = "/nonexistent";
            try {
                return events.get("before_agent_start")!() as
                    { message?: { customType?: string; content?: string } } | undefined;
            } finally {
                process.env.HOME = home;
            }
        },
        /** Simulates a finished agent turn that produced no relevant messages. */
        endTurn: () => events.get("agent_end")!({ messages: [] }, ctx),
        toolCall: (toolName: string, command: string) => events.get("tool_call")!({ toolName, input: { command } }),
        get activeTools() {
            return activeTools;
        },
        get status() {
            return status;
        },
        get planStatuses() {
            return statuses.filter((s) => s?.startsWith("plan: "));
        },
        get selectCalls() {
            return selectCalls;
        },
        lastNote: () => notes[notes.length - 1],
    };
}

test("fresh session starts in brainstorming with write tools disabled", () => {
    const h = createHarness();
    h.start();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, READ_ONLY_TOOLS);
    assert.equal(h.appended.at(-1)?.state, "brainstorming");
});

test("create flow: draft → planning → accept → implementing → auto-return", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();

    h.command("create");
    assert.deepEqual(h.sent, ["Produce the formal PRD now."]);
    assert.deepEqual(h.sentOpts.at(-1), { deliverAs: "followUp" });

    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.selectCalls, 1);
    assert.deepEqual(h.planStatuses, ["plan: brainstorming", "plan: planning", "plan: implementing"]);
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    assert.equal(h.sent.at(-1), "The plan is accepted. Begin implementation now.");
    assert.deepEqual(h.sentOpts.at(-1), { deliverAs: "followUp" });

    await h.endTurn();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, READ_ONLY_TOOLS);
    assert.equal(h.appended.at(-1)?.state, "brainstorming");
    assert.ok((h.appended.at(-1)?.steps ?? []).length > 0);
});

test("dialog reject → back to brainstorming, still read-only", async () => {
    const h = createHarness({ selectChoices: ["Back to brainstorming"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, READ_ONLY_TOOLS);
    assert.deepEqual(h.sent, ["Produce the formal PRD now."]);
});

test("dialog dismissed → stays planning", async () => {
    const h = createHarness({ selectChoices: [undefined] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.status, "plan: planning");
    assert.equal(h.sent.length, 1);
});

test("failed extraction keeps planning and warns", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("no plan here")]);
    assert.equal(h.status, "plan: planning");
    assert.equal(h.selectCalls, 0);
    assert.match(h.lastNote(), /no plan steps/i);
});

test("disable exits plan mode, restores tools, clears steps", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    await h.endTurn();

    h.command("disable");
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);
    assert.deepEqual(h.appended.at(-1)?.steps, []);
    assert.equal(h.appended.at(-1)?.state, "off");
});

test("legacy entries map enabled/steps onto states", () => {
    const fresh = (data: unknown) => {
        const h = createHarness({ entries: [entry(data)] });
        h.start();
        return h;
    };

    const legacyBrainstorm = fresh({ enabled: true, creating: false, steps: [] });
    assert.equal(legacyBrainstorm.status, "plan: brainstorming");
    assert.deepEqual(legacyBrainstorm.activeTools, READ_ONLY_TOOLS);

    const legacyPlanning = fresh({ enabled: true, creating: false, steps: [{ step: 1, text: "x" }] });
    assert.equal(legacyPlanning.status, "plan: planning");
    assert.deepEqual(legacyPlanning.activeTools, READ_ONLY_TOOLS);

    const legacyOff = fresh({ enabled: false, creating: false, steps: [] });
    assert.equal(legacyOff.status, undefined);
    assert.deepEqual(legacyOff.activeTools, FULL_TOOLS);
});

test("tool_call blocked in read-only states, free in implementing", () => {
    const readOnly = createHarness();
    readOnly.start();
    assert.equal(readOnly.toolCall("bash", "rm -rf /")?.block, true);
    assert.equal(readOnly.toolCall("bash", "git status"), undefined);
    assert.equal(readOnly.toolCall("bash", "echo $(cat /etc/passwd)")?.block, true);
    assert.equal(readOnly.toolCall("bash", 'echo "$(whoami)"')?.block, true);
    // added commands
    assert.equal(readOnly.toolCall("bash", "awk '{print \$1}'"), undefined);
    assert.equal(readOnly.toolCall("bash", "git blame src/index.ts"), undefined);
    assert.equal(readOnly.toolCall("bash", "npm ls"), undefined);
    assert.equal(readOnly.toolCall("bash", "pnpm outdated"), undefined);
    assert.equal(readOnly.toolCall("bash", "mix deps"), undefined);
    // 3-level gating
    assert.equal(readOnly.toolCall("bash", "uv pip list"), undefined);
    assert.equal(readOnly.toolCall("bash", "uv pip install requests")?.block, true);
    // removed from safeCommands
    assert.equal(readOnly.toolCall("bash", "xargs rm")?.block, true);

    const implementing = createHarness({ entries: [entry({ state: "implementing", steps: [] })] });
    implementing.start();
    assert.equal(implementing.toolCall("bash", "rm -rf /"), undefined);
});

test("auto-return notifies exactly once", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);

    const before = h.notes.length;
    await h.endTurn();
    assert.equal(h.notes.length - before, 1);
    assert.match(h.lastNote(), /brainstorming/i);
});

test("re-draft followed by dismiss persists the new steps", async () => {
    const REVISED_MD = "### Steps\n\n1. **Third step** — revised\n2. **Fourth step** — more\n";
    const h = createHarness({ selectChoices: [undefined, undefined] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);

    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(REVISED_MD)]);

    assert.deepEqual(h.appended.at(-1)?.steps, [
        { step: 1, text: "Third step" },
        { step: 2, text: "Fourth step" },
    ]);
});

test("before_agent_start injects the per-state skill file", () => {
    const h = createHarness();
    h.start();

    const result = h.beforeAgentStart();
    assert.equal(result?.message?.customType, "plan-context");
    assert.match(result?.message?.content ?? "", /# Brainstorming/);
});

test("before_agent_start does not inject skill in off state", () => {
    const h = createHarness({ entries: [entry({ state: "off", steps: [] })] });
    h.start();

    const result = h.beforeAgentStart();
    assert.equal(result, undefined);
});

test("create during streaming turn does not trigger dialog from wrong turn", async () => {
    const h = createHarness({ selectChoices: ["Implement now"], streaming: true });
    h.start();

    // agent is mid-turn (brainstorming) when /plan create runs
    h.command("create");
    assert.equal(h.sent.length, 1);

    // current brainstorming turn ends — should NOT trigger plan dialog
    await h.agentEnd([assistantMsg("Just exploring the codebase...")]);
    assert.equal(h.selectCalls, 0, "dialog should not fire after the in-progress turn");
    assert.equal(h.status, "plan: planning");

    // followUp is delivered by pi, new turn starts
    h.beforeAgentStart();
    // plan turn ends — SHOULD trigger dialog
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.selectCalls, 1, "dialog should fire after the plan turn");
    assert.equal(h.status, "plan: implementing");
});

test("create is rejected outside read-only states", () => {
    const h = createHarness({ entries: [entry({ state: "off", steps: [] })] });
    h.start();
    h.command("create");
    assert.equal(h.sent.length, 0);
    assert.match(h.lastNote(), /not in plan mode/i);
});
