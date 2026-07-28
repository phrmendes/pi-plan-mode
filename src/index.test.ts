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
    selectChoice?: string;
}

/**
 * Drives the real extension through a stubbed pi/ctx.
 * `selectChoice` is the canned approval-dialog answer; undefined simulates Esc.
 */
function createHarness(opts: HarnessOpts = {}) {
    const events = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
    let shortcutKey: string | undefined;
    let shortcutHandler: ((ctx: any) => any) | undefined;
    let activeTools = opts.tools ?? [...FULL_TOOLS];
    const appended: Array<{ state?: string; creating?: boolean; steps?: unknown[] }> = [];
    const sent: string[] = [];
    const sentOpts: Array<{ deliverAs?: string } | undefined> = [];
    const notes: string[] = [];
    let status: string | undefined;
    const statuses: Array<string | undefined> = [];
    let selectCalls = 0;

    const pi = {
        registerCommand: (name: string, def: any) => void commands.set(name, def),
        registerShortcut: (key: string, def: any) => {
            shortcutKey = key;
            shortcutHandler = def.handler;
        },
        on: (event: string, fn: any) => void events.set(event, fn),
        appendEntry: (_type: string, data: any) => void appended.push(data),
        sendUserMessage: (msg: string, opts?: { deliverAs?: string }) => void (sent.push(msg), sentOpts.push(opts)),
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
                return opts.selectChoice;
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
        cycle: () => shortcutHandler!(ctx),
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
        get shortcutKey() {
            return shortcutKey;
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

test("cycle shortcut is ctrl+alt+p", () => {
    const h = createHarness();
    assert.equal(h.shortcutKey, "ctrl+alt+p");
});

test("cycle: off → brainstorming, guarded without steps", () => {
    const h = createHarness({ entries: [entry({ state: "off", steps: [] })] });
    h.start();
    assert.equal(h.status, undefined);
    assert.deepEqual(h.activeTools, FULL_TOOLS);

    h.cycle();
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, READ_ONLY_TOOLS);

    h.cycle();
    assert.equal(h.status, "plan: brainstorming");
    assert.match(h.lastNote(), /no plan/i);
});

test("create flow: draft → proposing → accept → implementing → auto-return", async () => {
    const h = createHarness({ selectChoice: "Implement now" });
    h.start();

    h.command("create");
    assert.deepEqual(h.sent, ["Produce the formal plan now."]);
    assert.deepEqual(h.sentOpts.at(-1), { deliverAs: "followUp" });

    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.selectCalls, 1);
    assert.deepEqual(h.planStatuses, ["plan: brainstorming", "plan: proposing", "plan: implementing"]);
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

test("resume: brainstorming with steps cycles to proposing, then implementing", async () => {
    const h = createHarness({ selectChoice: "Implement now" });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    await h.endTurn();

    h.cycle();
    assert.equal(h.status, "plan: proposing");
    h.cycle();
    assert.equal(h.status, "plan: implementing");
    assert.deepEqual(h.activeTools, FULL_TOOLS);
});

test("dialog reject → back to brainstorming, still read-only", async () => {
    const h = createHarness({ selectChoice: "Back to brainstorming" });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.status, "plan: brainstorming");
    assert.deepEqual(h.activeTools, READ_ONLY_TOOLS);
    assert.deepEqual(h.sent, ["Produce the formal plan now."]);
});

test("dialog dismissed → stays proposing; shift+tab accepts", async () => {
    const dismissDialog = undefined;
    const h = createHarness({ selectChoice: dismissDialog });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.status, "plan: proposing");
    assert.equal(h.sent.length, 1);

    h.cycle();
    assert.equal(h.status, "plan: implementing");
    assert.equal(h.sent.at(-1), "The plan is accepted. Begin implementation now.");
});

test("failed extraction keeps brainstorming and warns", async () => {
    const h = createHarness({ selectChoice: "Implement now" });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg("no plan here")]);
    assert.equal(h.status, "plan: brainstorming");
    assert.equal(h.selectCalls, 0);
    assert.match(h.lastNote(), /no plan steps/i);
});

test("disable exits plan mode, restores tools, clears steps", async () => {
    const h = createHarness({ selectChoice: "Back to brainstorming" });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);

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

    const legacyProposing = fresh({ enabled: true, creating: false, steps: [{ step: 1, text: "x" }] });
    assert.equal(legacyProposing.status, "plan: proposing");
    assert.deepEqual(legacyProposing.activeTools, READ_ONLY_TOOLS);

    const legacyOff = fresh({ enabled: false, creating: false, steps: [] });
    assert.equal(legacyOff.status, undefined);
    assert.deepEqual(legacyOff.activeTools, FULL_TOOLS);
});

test("tool_call blocked in read-only states, free in implementing", () => {
    const readOnly = createHarness();
    readOnly.start();
    assert.equal(readOnly.toolCall("bash", "rm -rf /")?.block, true);
    assert.equal(readOnly.toolCall("bash", "git status"), undefined);

    const implementing = createHarness({ entries: [entry({ state: "implementing", steps: [] })] });
    implementing.start();
    assert.equal(implementing.toolCall("bash", "rm -rf /"), undefined);
});

test("auto-return notifies exactly once", async () => {
    const h = createHarness({ selectChoice: "Implement now" });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);

    const before = h.notes.length;
    await h.endTurn();
    assert.equal(h.notes.length - before, 1);
    assert.match(h.lastNote(), /ctrl\+alt\+p/i);
});

test("re-draft followed by dismiss persists the new steps", async () => {
    const REVISED_MD = "### Steps\n\n1. **Third step** — revised\n2. **Fourth step** — more\n";
    const dismissDialog = undefined;
    const h = createHarness({ selectChoice: dismissDialog });
    h.start();
    h.command("create");
    await h.agentEnd([assistantMsg(PLAN_MD)]);

    h.command("create");
    await h.agentEnd([assistantMsg(REVISED_MD)]);

    assert.deepEqual(h.appended.at(-1)?.steps, [
        { step: 1, text: "Third step" },
        { step: 2, text: "Fourth step" },
    ]);
});

test("before_agent_start injects the bundled skill while creating", () => {
    const h = createHarness();
    h.start();
    h.command("create");

    const result = h.beforeAgentStart();
    assert.equal(result?.message?.customType, "plan-context");
    assert.match(result?.message?.content ?? "", /# Plan Mode/);
});

test("create is rejected outside read-only states", () => {
    const h = createHarness({ entries: [entry({ state: "off", steps: [] })] });
    h.start();
    h.command("create");
    assert.equal(h.sent.length, 0);
    assert.match(h.lastNote(), /not in plan mode/i);
});
