import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivePhase } from "./state.ts";

export interface PlanModes extends Record<ActivePhase, { model?: string }> {
    brainstorming: { model?: string; deniedTools: string[] };
    implementing: { model?: string };
    /** The model that `/plan thk` toggles on during brainstorming. */
    thinking: { model?: string };
}

export interface PlanConfig {
    modes: PlanModes;
    errors: string[];
}

/** Returns the configuration that changes nothing: no models and no extra denied tools. */
export function emptyModes(): PlanModes {
    return { brainstorming: { deniedTools: [] }, implementing: {}, thinking: {} };
}

/** Returns the plan.json path in the pi agent directory. */
export function planConfigPath(): string {
    return join(getAgentDir(), "plan.json");
}

/** Splits `provider/id` on the first slash, because model ids can contain slashes. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
    const separator = ref.indexOf("/");
    if (separator < 0) return undefined;
    const provider = ref.slice(0, separator).trim();
    const id = ref.slice(separator + 1).trim();
    return provider && id ? { provider, id } : undefined;
}

/** Returns whether a value is a plain JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads one phase's optional model, reporting a value that is not `provider/id`. */
function readModel(value: unknown, key: string, errors: string[]): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "string" && splitModelRef(value)) return value.trim();
    errors.push(`"${key}" must be "provider/id"`);
    return undefined;
}

/** Reads the deny list as trimmed, unique tool names, dropping empty entries and a bare `*`. */
function readDeniedTools(value: unknown, key: string, errors: string[]): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        errors.push(`"${key}" must be an array of tool names`);
        return [];
    }
    const tools = value.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim());
    if (tools.includes("*")) {
        errors.push(`"*" would deny every tool and is ignored; list tool names or prefixes such as mcp__server__*`);
    }
    return [...new Set(tools.filter((tool) => tool.length > 0 && tool !== "*"))];
}

/** Reads one phase object, reporting a value that is not an object. */
function readPhase(modes: Record<string, unknown>, phase: keyof PlanModes, errors: string[]): Record<string, unknown> {
    const value = modes[phase];
    if (value === undefined) return {};
    if (isObject(value)) return value;
    errors.push(`"modes.${phase}" must be an object`);
    return {};
}

/** Reads a mode that holds only a model. */
function readModelMode(
    modes: Record<string, unknown>,
    mode: "implementing" | "thinking",
    errors: string[],
): { model?: string } {
    const model = readModel(readPhase(modes, mode, errors).model, `modes.${mode}.model`, errors);
    return model ? { model } : {};
}

/** Normalizes the parsed plan.json object; every bad value is reported and ignored. */
function readModes(parsed: Record<string, unknown>, errors: string[]): PlanModes {
    if (parsed.allowedTools !== undefined) {
        errors.push(`"allowedTools" is no longer supported; list tools to block in "modes.brainstorming.deniedTools"`);
    }
    if (parsed.modes === undefined) return emptyModes();
    if (!isObject(parsed.modes)) {
        errors.push(`"modes" must be an object`);
        return emptyModes();
    }
    const brainstorming = readPhase(parsed.modes, "brainstorming", errors);
    const brainstormingModel = readModel(brainstorming.model, "modes.brainstorming.model", errors);
    return {
        brainstorming: {
            ...(brainstormingModel ? { model: brainstormingModel } : {}),
            deniedTools: readDeniedTools(brainstorming.deniedTools, "modes.brainstorming.deniedTools", errors),
        },
        implementing: readModelMode(parsed.modes, "implementing", errors),
        thinking: readModelMode(parsed.modes, "thinking", errors),
    };
}

/** Reads one plan.json file. A missing or blank file means no configuration. */
export function loadPlanConfig(path: string): PlanConfig {
    if (!existsSync(path)) return { modes: emptyModes(), errors: [] };
    let parsed: unknown;
    try {
        const content = readFileSync(path, "utf-8");
        if (content.trim().length === 0) return { modes: emptyModes(), errors: [] };
        parsed = JSON.parse(content);
    } catch (error) {
        return { modes: emptyModes(), errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!isObject(parsed)) {
        return { modes: emptyModes(), errors: [`${path}: expected a JSON object with a "modes" object`] };
    }
    const errors: string[] = [];
    const modes = readModes(parsed, errors);
    return { modes, errors: errors.map((error) => `${path}: ${error}`) };
}
