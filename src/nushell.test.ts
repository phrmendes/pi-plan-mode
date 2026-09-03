import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPlanningCommand } from "./nushell.ts";

const allowed = [
    "git status",
    "git blame src/index.ts",
    "ls",
    "find . -name '*.ts'",
    "pwd",
    "which node",
    "glob **/*.ts",
    'open --raw src/index.ts | lines | where $it =~ "TODO"',
    "kubectl get pods -o json | from json | get items",
    "open package.json | get scripts",
    "ast-grep run --pattern 'foo($$$)' --lang typescript src",
    "pnpm test",
    "pnpm run typecheck",
    "npm view typescript version",
    "uv pip show requests",
];
const blocked = [
    "rm -rf /",
    "find . -delete",
    "find . -exec cat {} \\;",
    "git config key value",
    "git diff --output=result",
    "pnpm format",
    "pnpm run build",
    "curl -X POST https://example.com",
    "echo $(whoami)",
    "cat file > copy",
    "pwd\nrm -rf /",
    "ls | save report.txt",
    "rm -r build",
    "python script.py",
    "bash -c 'rm -rf build'",
    "do { ^rm -rf build }",
    "each {|item| ^kubectl delete pod $item}",
    "open ($path | path expand) | lines",
    'echo "output" | save report.txt',
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
