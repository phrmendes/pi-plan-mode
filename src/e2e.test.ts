import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import planMode, { type PlanModeOptions } from "./index.ts";
import type { PlanProposal } from "./state.ts";

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
    tests: [
        {
            path: "src/index.test.ts",
            test: "Registers the plan control tools, command, and renderer",
        },
    ],
};

/** Builds a real pi agent session wired to a scripted (network-free) fake model. */
async function createFakeModelSession(sessionManager: SessionManager, options: PlanModeOptions = {}) {
    const faux = fauxProvider();
    let hostApi!: ExtensionAPI;
    const fauxProviderExtension = (pi: ExtensionAPI): void => {
        hostApi = pi;
        pi.registerProvider(faux.provider);
    };

    // Use a scratch agent dir, not getAgentDir(), so the test only loads the local extension under
    // test and never a real globally-installed copy of this same package.
    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: mkdtempSync(join(tmpdir(), "pi-plan-mode-e2e-")),
        extensionFactories: [(pi) => planMode(pi, options), fauxProviderExtension],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        resourceLoader,
        sessionManager,
        model: faux.getModel(),
    });
    // Bare createAgentSession() does not fire session_start; that only happens once extensions
    // are bound to a running mode (normally done by pi's interactive/print/RPC runners).
    await session.bindExtensions({ mode: "print" });

    return { session, faux, pi: hostApi };
}

function lastPlanModeEntry(sessionManager: SessionManager): { phase?: string } | undefined {
    const entries = sessionManager
        .getEntries()
        .filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom")
        .filter((entry) => entry.customType === "plan-mode");
    return entries.at(-1)?.data as { phase?: string } | undefined;
}

test("brainstorming: a real agent turn calling plan_propose surfaces the formatted proposal", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager);

    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("plan_propose", PROPOSAL)], { stopReason: "toolUse" }),
        fauxAssistantMessage("Proposal submitted for review.", { stopReason: "stop" }),
    ]);

    await session.prompt("Refactor the plan-mode workflow.");

    const transcript = JSON.stringify(sessionManager.getEntries());
    assert.match(transcript, /## Description/);
    assert.match(transcript, /Simplify the proposal flow/);
    assert.match(transcript, /mcp__browser__/);
    assert.match(transcript, /## Tests/);
    assert.match(transcript, /Registers the plan control tools/);

    session.dispose();
});

test(
    "implementing: the agent_settled reminder brings a silently-idle agent back to call plan_complete",
    { timeout: 5000 },
    async () => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendCustomEntry("plan-mode", {
            phase: "implementing",
            proposal: PROPOSAL,
            savedTools: FULL_TOOLS,
        });
        const { session, faux } = await createFakeModelSession(sessionManager);

        // First turn: the model finishes without calling plan_complete (the bug we are guarding against).
        // Second turn: triggered automatically by the extension's agent_settled reminder.
        faux.setResponses([
            fauxAssistantMessage("The change is done and verified.", { stopReason: "stop" }),
            fauxAssistantMessage([fauxToolCall("plan_complete", {})], { stopReason: "toolUse" }),
            fauxAssistantMessage("Acknowledged.", { stopReason: "stop" }),
        ]);

        // The reminder fires asynchronously after the first turn settles, so wait for its effect
        // (plan_complete reverting the phase) rather than for a specific count of framework events.
        const planModeDisabled = new Promise<void>((resolve) => {
            if (lastPlanModeEntry(sessionManager)?.phase === "off") {
                resolve();
                return;
            }
            const unsubscribe = session.subscribe((event) => {
                if (event.type !== "entry_appended") return;
                if (lastPlanModeEntry(sessionManager)?.phase !== "off") return;
                unsubscribe();
                resolve();
            });
        });

        await session.prompt("Implement the accepted proposal.");
        await planModeDisabled;

        assert.ok(faux.state.callCount >= 2, "the reminder should have triggered a second model turn");
        assert.equal(lastPlanModeEntry(sessionManager)?.phase, "off");

        session.dispose();
    },
);

test("brainstorming: tools that connect after startup reach the model only when allowed", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux, pi } = await createFakeModelSession(sessionManager, {
        allowedTools: ["mcp__demo__read_page"],
    });
    for (const name of ["mcp__demo__read_page", "mcp__demo__delete_all"]) {
        pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            async execute() {
                return { content: [{ type: "text" as const, text: "ok" }], details: {} };
            },
        });
    }

    let offered: string[] = [];
    faux.setResponses([
        () => {
            offered = session.getActiveToolNames();
            return fauxAssistantMessage("Inspected.", { stopReason: "stop" });
        },
    ]);
    await session.prompt("Inspect the project.");

    assert.deepEqual(offered.sort(), [
        "find",
        "grep",
        "ls",
        "mcp__demo__read_page",
        "plan_ask",
        "plan_propose",
        "read",
    ]);
    session.dispose();
});

test("off: a resumed session does not expose the plan control tools", async () => {
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendCustomEntry("plan-mode", { phase: "off", savedTools: FULL_TOOLS });
    const { session } = await createFakeModelSession(sessionManager);
    assert.deepEqual(
        session.getActiveToolNames().filter((name) => name.startsWith("plan_")),
        [],
    );
    session.dispose();
});

test("session tree: navigating to an earlier branch restores that branch's plan phase", async () => {
    const sessionManager = SessionManager.inMemory();
    const brainstormingEntry = sessionManager.appendCustomEntry("plan-mode", {
        phase: "brainstorming",
        savedTools: FULL_TOOLS,
    });
    sessionManager.appendCustomEntry("plan-mode", {
        phase: "implementing",
        proposal: PROPOSAL,
        savedTools: FULL_TOOLS,
    });
    const { session } = await createFakeModelSession(sessionManager);
    assert.ok(session.getActiveToolNames().includes("plan_complete"));

    await session.navigateTree(brainstormingEntry, { summarize: false });

    assert.deepEqual(session.getActiveToolNames().sort(), ["find", "grep", "ls", "plan_ask", "plan_propose", "read"]);
    session.dispose();
});
