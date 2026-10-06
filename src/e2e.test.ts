import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createAgentSession,
    createCodemodeExtension,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import planMode from "./index.ts";
import type { PlanProposal } from "./proposal.ts";

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
    tests: [
        {
            path: "src/index.test.ts",
            test: "Registers the plan control tools, command, and renderer",
        },
    ],
};

interface SessionSetup {
    /** Contents of plan.json in the scratch agent directory. */
    plan?: unknown;
    /** Loads and activates the codemode tool. */
    codemode?: boolean;
    /** Extra extensions loaded before the session starts, as MCP servers are. */
    extensions?: Array<(pi: ExtensionAPI) => void>;
}

/** Builds a real pi agent session wired to a scripted (network-free) fake model. */
async function createFakeModelSession(sessionManager: SessionManager, setup: SessionSetup = {}) {
    const faux = fauxProvider();
    let hostApi!: ExtensionAPI;
    const fauxProviderExtension = (pi: ExtensionAPI): void => {
        hostApi = pi;
        pi.registerProvider(faux.provider);
    };

    // Use a scratch agent dir for everything, so the test never loads a globally installed copy of
    // this package, the user's settings, or the user's plan.json.
    const agentDir = mkdtempSync(join(tmpdir(), "pi-plan-mode-e2e-"));
    if (setup.plan !== undefined) writeFileSync(join(agentDir, "plan.json"), JSON.stringify(setup.plan));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const settingsManager = SettingsManager.inMemory(setup.codemode ? { defaultTools: ["+codemode"] } : {});
    const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir,
        settingsManager,
        extensionFactories: [
            (pi) => planMode(pi),
            fauxProviderExtension,
            ...(setup.codemode ? [createCodemodeExtension()] : []),
            ...(setup.extensions ?? []),
        ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
        agentDir,
        settingsManager,
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
    assert.match(transcript, /## Tests/);
    assert.match(transcript, /Registers the plan control tools/);

    session.dispose();
});

test(
    "implementing: the agent_settled reminder completes the implementation cycle into brainstorming",
    { timeout: 5000 },
    async () => {
        const sessionManager = SessionManager.inMemory();
        sessionManager.appendCustomEntry("plan-mode", {
            phase: "implementing",
            proposal: PROPOSAL,
            savedTools: FULL_TOOLS,
        });
        const { session, faux } = await createFakeModelSession(sessionManager);

        faux.setResponses([
            fauxAssistantMessage("The change is done and verified.", { stopReason: "stop" }),
            fauxAssistantMessage([fauxToolCall("plan_complete", {})], { stopReason: "toolUse" }),
            fauxAssistantMessage("Acknowledged.", { stopReason: "stop" }),
        ]);

        const returnedToBrainstorming = new Promise<void>((resolve) => {
            if (lastPlanModeEntry(sessionManager)?.phase === "brainstorming") {
                resolve();
                return;
            }
            const unsubscribe = session.subscribe((event) => {
                if (event.type !== "entry_appended") return;
                if (lastPlanModeEntry(sessionManager)?.phase !== "brainstorming") return;
                unsubscribe();
                resolve();
            });
        });

        await session.prompt("Implement the accepted proposal.");
        await returnedToBrainstorming;

        assert.ok(faux.state.callCount >= 2, "the reminder should have triggered a second model turn");
        assert.equal(lastPlanModeEntry(sessionManager)?.phase, "brainstorming");
        assert.deepEqual(session.getActiveToolNames().sort(), [
            "find",
            "grep",
            "ls",
            "plan_ask",
            "plan_propose",
            "read",
        ]);

        session.dispose();
    },
);

test("brainstorming: tools that connect after startup reach the model unless denied", async () => {
    const sessionManager = SessionManager.inMemory();
    const { session, faux, pi } = await createFakeModelSession(sessionManager, {
        plan: { modes: { brainstorming: { deniedTools: ["mcp__demo__delete_all"] } } },
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

test("brainstorming: a codemode script can call allowed tools but not denied ones", async () => {
    const executed: string[] = [];
    const demoServer = (pi: ExtensionAPI): void => {
        for (const name of ["mcp__demo__read_page", "mcp__demo__delete_all"]) {
            pi.registerTool({
                name,
                label: name,
                description: name,
                exposure: "codemode",
                parameters: Type.Object({}),
                async execute() {
                    executed.push(name);
                    return { content: [{ type: "text" as const, text: "ok" }], details: {} };
                },
            });
        }
    };
    const sessionManager = SessionManager.inMemory();
    const { session, faux } = await createFakeModelSession(sessionManager, {
        plan: { modes: { brainstorming: { deniedTools: ["mcp__demo__delete_all"] } } },
        codemode: true,
        extensions: [demoServer],
    });
    const script = [
        "const results = await Promise.allSettled([",
        "    tools.mcp__demo__read_page({}),",
        "    tools.mcp__demo__delete_all({}),",
        "]);",
        'return results.map((result) => (result.status === "fulfilled" ? "ok" : result.reason.message));',
    ].join("\n");
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: script })], { stopReason: "toolUse" }),
        fauxAssistantMessage("Inspected.", { stopReason: "stop" }),
    ]);

    await session.prompt("Inspect the demo.");

    assert.deepEqual(executed, ["mcp__demo__read_page"]);
    assert.match(
        JSON.stringify(sessionManager.getEntries()),
        /mcp__demo__delete_all.{0,40}not available during brainstorming/,
    );
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
