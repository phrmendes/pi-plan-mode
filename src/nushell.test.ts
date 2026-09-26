import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedPlanningCommand } from "./nushell.ts";

const allowed = [
    "which nu; which pnpm; git status",
    "let files = (glob **/*.nix)",
    "ls | each { |item| $item.name }",
    "git status",
    "open package.json | get scripts",
    "quoted = 'save report.txt'",
    "open 'save report.txt'",
    "echo documentation.md",
];

const blocked = [
    "rm -rf /",
    "find . -delete",
    "find . -exec cat {} \\;",
    "git config key value",
    "git diff --output=result",
    "ls | save report.txt",
    "rm -r build",
    "python script.py",
    "bash -c 'rm -rf build'",
    "do { ^kubectl delete pod $item }",
    "echo --rewrite rule.yml .",
    "run-external rm",
    "echo output --exec",
];

test("allows normal Nushell syntax and read-only commands", () => {
    for (const command of allowed) assert.equal(isAllowedPlanningCommand(command), true, command);
});

test("blocks commands containing mutation or execution tokens", () => {
    for (const command of blocked) assert.equal(isAllowedPlanningCommand(command), false, command);
});

test("uses token boundaries instead of substring matching", () => {
    assert.equal(isAllowedPlanningCommand("echo savepoint"), true);
    assert.equal(isAllowedPlanningCommand("echo removeable"), true);
    assert.equal(isAllowedPlanningCommand("echo save"), false);
});
