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
    const appended: Array<{
        state?: string;
        planTurnActive?: boolean;
        pendingPlanRequest?: number;
        steps?: unknown[];
    }> = [];
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

test("failed extraction warns but still shows dialog", async () => {
    const h = createHarness({ selectChoices: ["Back to brainstorming"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("no plan here")]);
    assert.match(h.notes.join(" "), /no steps extracted/i);
    assert.equal(h.selectCalls, 1, "dialog must always appear");
    assert.equal(h.status, "plan: brainstorming");
});

test("failed extraction with accept transitions to implementing", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("no plan here")]);
    assert.equal(h.selectCalls, 1);
    assert.equal(h.status, "plan: implementing");
});

test("extraction matches heading substrings like ## Implementation Steps", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("## Implementation Steps\n\n1. **Do X** — because\n2. **Do Y** — also")]);
    assert.equal(h.selectCalls, 1);
    assert.equal(h.status, "plan: implementing");
});

test("extraction handles files section before steps", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("### Files\n\n- `src/a.ts` — entry\n\n### Steps\n\n1. **Refactor** — cleanup")]);
    assert.equal(h.selectCalls, 1);
    assert.equal(h.status, "plan: implementing");
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
    assert.equal(readOnly.toolCall("bash", "awk '{print \$1}'")?.block, true);
    assert.equal(readOnly.toolCall("bash", "env rm -rf /")?.block, true);
    assert.equal(readOnly.toolCall("bash", "find . -exec cat {} \\;")?.block, true);
    assert.equal(readOnly.toolCall("bash", "find . -execdir ls {} \\;")?.block, true);
    assert.equal(readOnly.toolCall("bash", "printenv"), undefined);
    assert.equal(readOnly.toolCall("bash", "git blame src/index.ts"), undefined);
    assert.equal(readOnly.toolCall("bash", "npm ls"), undefined);
    assert.equal(readOnly.toolCall("bash", "pnpm outdated"), undefined);
    assert.equal(readOnly.toolCall("bash", "mix deps"), undefined);
    // 3-level gating
    assert.equal(readOnly.toolCall("bash", "uv pip list"), undefined);
    assert.equal(readOnly.toolCall("bash", "uv pip install requests")?.block, true);
    // removed from safeCommands
    assert.equal(readOnly.toolCall("bash", "xargs rm")?.block, true);
    assert.equal(readOnly.toolCall("bash", "sed s/foo/bar/ file")?.block, true);

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

test("before_agent_start injects plan steps into implementing skill", () => {
    const h = createHarness({
        entries: [
            entry({
                state: "implementing",
                steps: [
                    { step: 1, text: "Add login" },
                    { step: 2, text: "Wire DB" },
                ],
            }),
        ],
    });
    h.start();
    const result = h.beforeAgentStart();
    assert.ok(result?.message?.content?.includes("Add login"), "steps injected into skill");
    assert.ok(result?.message?.content?.includes("Wire DB"));
});

test("brainstorming guardrail warns when agent proposes plan unprompted", async () => {
    const h = createHarness();
    h.start();
    const sentBefore = h.sent.length;
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.match(h.lastNote(), /unprompted/i);
    assert.equal(h.sent.length, sentBefore, "no followUp sent — zero token cost");
});

test("brainstorming guardrail is silent when response has no plan", async () => {
    const h = createHarness();
    h.start();
    const notesBefore = h.notes.length;
    await h.agentEnd([assistantMsg("Just exploring the codebase, found some issues.")]);
    assert.equal(h.notes.length, notesBefore);
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

test("double create surfaces both plan dialogs", async () => {
    const h = createHarness({ selectChoices: ["Implement now", "Implement now"], streaming: true });
    h.start();

    // spam create twice during a streaming turn
    h.command("create");
    h.command("create");
    assert.equal(h.sent.length, 2);

    // in-progress turn ends — no dialog
    await h.agentEnd([assistantMsg("Exploring...")]);
    assert.equal(h.selectCalls, 0);

    // first followUp turn
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg(PLAN_MD)]);
    assert.equal(h.selectCalls, 1, "first plan should show dialog");

    // second followUp turn
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("### Steps\n\n1. **Revised** — better")]);
    assert.equal(h.selectCalls, 2, "second plan should show dialog");
});

test("extraction accepts short titles and em-dash separators", async () => {
    const h = createHarness({ selectChoices: ["Implement now"] });
    h.start();
    h.command("create");
    h.beforeAgentStart();
    await h.agentEnd([assistantMsg("### Steps\n\n1. **Go** — runs\n2. **Fix** — corrects\n3. **Refactor** — cleans")]);
    assert.equal(h.selectCalls, 1);
    assert.equal(h.status, "plan: implementing");

    // restart for em-dash test
    const h2 = createHarness({ selectChoices: ["Implement now"] });
    h2.start();
    h2.command("create");
    h2.beforeAgentStart();
    await h2.agentEnd([assistantMsg("### Steps\n\n1. **Add login** — add auth\n2. **Wire DB** -- connect")]);
    assert.equal(h2.selectCalls, 1);
});

test("create is rejected outside read-only states", () => {
    const h = createHarness({ entries: [entry({ state: "off", steps: [] })] });
    h.start();
    h.command("create");
    assert.equal(h.sent.length, 0);
    assert.match(h.lastNote(), /not in plan mode/i);
});
