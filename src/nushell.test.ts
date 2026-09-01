import { test } from "node:test";
import assert from "node:assert/strict";
import { createNushellExecutor, isAllowedPlanningCommand, type NushellProcessResult } from "./nushell.ts";

const allowed = [
    "git status",
    "git blame src/index.ts",
    "ls",
    "find . -name '*.ts'",
    "pwd",
    "which node",
    "glob **/*.ts",
    'open --raw src/index.ts | lines | where $it =~ "TODO"',
    "pnpm outdated",
    "pnpm test",
    "pnpm run typecheck",
    "npm run typecheck",
    "open --raw src/index.ts | lines | length",
    "open --raw README.md",
    'open --raw src/index.ts | lines | where $it =~ "TODO"',
    "ls | where type == file | select name",
    "open 'a|b.txt' | lines",
    'open rm.txt | where name == "save"',
    'where name == "delete" | select name',
    "ast-grep run --pattern 'foo($$$)' --lang typescript src",
    "gcloud projects list",
    "gcloud compute instances describe example --zone us-central1-a",
    "kubectl get pods -o json",
    "kubectl describe pod example",
    "kubectl get pods -o json | from json | get items",
    "open package.json | get scripts",
    "uv list",
    "uv pip show requests",
    "uv pip list",
    "npm view typescript version",
    "npm list --depth=0",
    "pnpm list --depth=0",
    "pnpm outdated",
    "pnpm test",
    "pnpm run typecheck",
];
const blocked = [
    "rm -rf /",
    "find . -delete",
    "find . -exec cat {} \\;",
    "fd -x rm",
    "fd --exec=touch",
    "fd --exec-batch=touch",
    "rg --pre=rm pattern",
    "git config key value",
    "git diff --output=result",
    "pnpm format",
    "pnpm run build",
    "npm run release",
    "curl -X POST https://example.com",
    "echo $(whoami)",
    "cat file > copy",
    "pwd\nrm -rf /",
    "cat < secret",
    "FOO=bar pwd",
    "cat <(ls)",
    "git --exec-path status",
    "basename src/index.ts",
    "cat README.md",
    "fd '*.ts' src",
    "grep TODO src/index.ts",
    "head -5 README.md",
    "jq '.scripts' package.json",
    "rg TODO src",
    "tail -5 README.md",
    "tr a-z A-Z",
    "wc -l src/index.ts",
    "ls | save report.txt",
    "rm -r build",
    "ast-grep scan --rewrite rule.yml .",
    "gcloud projects create example",
    "gcloud projects delete example",
    "gcloud config set project example",
    "kubectl apply -f deployment.yml",
    "kubectl delete pod example",
    "uv pip install requests",
    "npm install lodash",
    "npm publish",
    "pnpm add lodash",
    "pnpm remove lodash",
    "pnpm run build",
    "kubectl get pods | save pods.txt",
    "do { ^rm -rf build }",
    "each {|item| ^kubectl delete pod $item}",
    "open ($path | path expand) | lines",
    '$"output: (save report.txt)"',
    "alias inspect = ls",
    "def inspect [] { ls }",
    "source setup.nu",
    "use module.nu",
    "overlay use module",
    "run-external rm",
];

test("allows the read-only planning Nushell subset", () => {
    for (const command of allowed) assert.equal(isAllowedPlanningCommand(command), true, command);
});

test("blocks mutations and unsupported planning commands", () => {
    for (const command of blocked) assert.equal(isAllowedPlanningCommand(command), false, command);
});

test("covers the planning capability matrix", () => {
    const cases = [
        ["file inspection", "open README.md | lines | first 20", true],
        ["source search", 'open src/index.ts | lines | where $it =~ "registerTool"', true],
        ["structured data", "open package.json | get scripts", true],
        ["git history", "git log --oneline -5", true],
        ["AST inspection", "ast-grep run --pattern 'foo($$$)' --lang typescript src", true],
        ["test verification", "pnpm test", true],
        ["file mutation", "touch new-file", false],
        ["pipeline mutation", "ls | save report.txt", false],
    ] as const;
    for (const [name, command, expected] of cases) {
        assert.equal(isAllowedPlanningCommand(command), expected, name);
    }
});

function fakeRunner(results: Record<string, NushellProcessResult> = {}) {
    const calls: string[] = [];
    return {
        calls,
        runner: async (command: string): Promise<NushellProcessResult> => {
            calls.push(command);
            return (
                results[command] ?? {
                    stdout: "ran",
                    stderr: "",
                    exitCode: 0,
                }
            );
        },
    };
}

test("restricted execution rejects blocked commands before running them", async () => {
    const { calls, runner } = fakeRunner();
    const executor = createNushellExecutor(runner);
    await assert.rejects(executor.execute("ls | save report.txt", { restricted: true }), /blocked/i);
    assert.deepEqual(calls, []);
});

test("restricted execution runs allowed commands and returns output", async () => {
    const { calls, runner } = fakeRunner({
        "open package.json | get scripts": { stdout: "test\ntypecheck", stderr: "", exitCode: 0 },
    });
    const executor = createNushellExecutor(runner);
    const result = await executor.execute("open package.json | get scripts", { restricted: true });
    assert.equal(result.content[0].text, "test\ntypecheck");
    assert.deepEqual(result.details, { exitCode: 0 });
    assert.deepEqual(calls, ["open package.json | get scripts"]);
});

test("unrestricted execution bypasses the planning policy", async () => {
    const { calls, runner } = fakeRunner({ "rm -r build": { stdout: "", stderr: "", exitCode: 0 } });
    const executor = createNushellExecutor(runner);
    const result = await executor.execute("rm -r build", { restricted: false });
    assert.equal(result.content[0].text, "(no output)");
    assert.deepEqual(calls, ["rm -r build"]);
});

test("unrestricted execution surfaces non-zero exits as output", async () => {
    const executor = createNushellExecutor(async () => ({ stdout: "", stderr: "missing file", exitCode: 2 }));
    const result = await executor.execute("open missing.nu", { restricted: false });
    assert.equal(result.content[0].text, "missing file");
    assert.deepEqual(result.details, { exitCode: 2 });
});
