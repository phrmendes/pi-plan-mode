import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, matchesGlob as globMatches } from "node:path";

/** Returns the plan.json path in the pi agent directory. */
export function planConfigPath(): string {
    return join(getAgentDir(), "plan.json");
}

/** Expands a leading `~` in a glob pattern. */
function expandHome(pattern: string): string {
    if (pattern === "~") return homedir();
    return pattern.startsWith("~/") ? join(homedir(), pattern.slice(2)) : pattern;
}

/** Matches a path against a glob, expanding a leading `~` in the pattern. */
export function matchesGlob(value: string, pattern: string): boolean {
    return globMatches(value, expandHome(pattern));
}

/** Finds the nearest `.plan.json` from `cwd` up to a git root. */
export function findLocalPlanConfig(cwd: string): string | undefined {
    let directory = cwd;
    while (true) {
        const candidate = join(directory, ".plan.json");
        if (existsSync(candidate)) return candidate;
        if (existsSync(join(directory, ".git"))) return undefined;
        const parent = dirname(directory);
        if (parent === directory) return undefined;
        directory = parent;
    }
}
