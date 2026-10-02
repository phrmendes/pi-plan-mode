import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PlanConfig {
    allowedTools: string[];
    errors: string[];
}

/** Returns the plan.json path in the pi agent directory. */
export function planConfigPath(): string {
    return join(getAgentDir(), "plan.json");
}

/** Normalizes an `allowedTools` value into trimmed, unique tool names, dropping empty entries and a bare `*`. */
export function parseAllowedTools(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const tools = value.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim());
    return [...new Set(tools.filter((tool) => tool.length > 0 && tool !== "*"))];
}

/** Reads one plan.json file and normalizes its allowlist. */
export function loadPlanConfig(path: string): PlanConfig {
    if (!existsSync(path)) return { allowedTools: [], errors: [] };
    let parsed: unknown;
    try {
        const content = readFileSync(path, "utf-8");
        if (content.trim().length === 0) return { allowedTools: [], errors: [] };
        parsed = JSON.parse(content);
    } catch (error) {
        return { allowedTools: [], errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { allowedTools: [], errors: [`${path}: expected a JSON object with an "allowedTools" array`] };
    }
    const value = (parsed as { allowedTools?: unknown }).allowedTools;
    if (value !== undefined && !Array.isArray(value)) {
        return { allowedTools: [], errors: [`${path}: "allowedTools" must be an array of tool names`] };
    }
    const wildcard = Array.isArray(value) && value.some((tool) => typeof tool === "string" && tool.trim() === "*");
    return {
        allowedTools: parseAllowedTools(value),
        errors: wildcard
            ? [`${path}: "*" would allow every tool and is ignored; list tool names or prefixes such as mcp__server__*`]
            : [],
    };
}
