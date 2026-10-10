import { existsSync, readFileSync } from "node:fs";
import { isThinkingLevel, STAGE_KEYS, THINKING_LEVELS, type StageKey, type ThinkingLevel } from "./state.ts";

export interface PlanStage {
    model?: string;
    thinkingLevel?: ThinkingLevel;
}

export interface BrainstormingStage extends PlanStage {
    deniedTools: string[];
}

export interface PlanModes {
    brainstorming: BrainstormingStage;
    implementing: PlanStage;
    thinking: PlanStage;
}

export interface StageFields {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    deniedTools?: string[];
}

export type ParsedModes = Partial<Record<StageKey, StageFields>>;

export interface ParsedProfile {
    extends?: string;
    match: string[];
    deniedTools: string[];
    modes: ParsedModes;
}

export interface PlanFile {
    activeProfile?: string;
    deniedTools: string[];
    profiles: Record<string, ParsedProfile>;
    errors: string[];
}

/** Returns the configuration that changes nothing: no models and no extra denied tools. */
export function emptyModes(): PlanModes {
    return { brainstorming: { deniedTools: [] }, implementing: {}, thinking: {} };
}

/** Splits `provider/id` on the first slash, because model ids can contain slashes. */
export function splitModelRef(ref: string): { provider: string; id: string } | undefined {
    const separator = ref.indexOf("/");
    if (separator < 0) return undefined;
    const provider = ref.slice(0, separator).trim();
    const id = ref.slice(separator + 1).trim();
    return provider && id ? { provider, id } : undefined;
}

/** Returns unique values, keeping the first occurrence. */
export function unique(values: string[]): string[] {
    return [...new Set(values)];
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

/** Reads one phase's optional thinking level, reporting an unknown level. */
function readThinkingLevel(value: unknown, key: string, errors: string[]): ThinkingLevel | undefined {
    if (value === undefined) return undefined;
    if (isThinkingLevel(value)) return value;
    errors.push(`"${key}" must be one of ${THINKING_LEVELS.join(", ")}`);
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
    return unique(tools.filter((tool) => tool.length > 0 && tool !== "*"));
}

/** Reads one phase object, reporting a value that is not an object. */
function readPhase(value: unknown, key: string, errors: string[]): Record<string, unknown> | undefined {
    if (value === undefined) return {};
    if (isObject(value)) return value;
    errors.push(`"${key}" must be an object`);
    return undefined;
}

/** Reads the fields of one stage under a key prefix such as `modes.brainstorming`. */
function readStageFields(
    phase: Record<string, unknown>,
    stage: StageKey,
    prefix: string,
    errors: string[],
): StageFields {
    const model = readModel(phase.model, `${prefix}.model`, errors);
    const thinkingLevel = readThinkingLevel(phase.thinkingLevel, `${prefix}.thinkingLevel`, errors);
    const deniedTools =
        stage === "brainstorming" ? readDeniedTools(phase.deniedTools, `${prefix}.deniedTools`, errors) : undefined;
    return {
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(deniedTools ? { deniedTools } : {}),
    };
}

/** Reads a stage map under a key prefix, reporting each bad stage. */
function readStages(stages: Record<string, unknown>, prefix: string, errors: string[]): ParsedModes {
    const modes: ParsedModes = {};
    for (const stage of STAGE_KEYS) {
        const phase = readPhase(stages[stage], `${prefix}.${stage}`, errors);
        if (phase) modes[stage] = readStageFields(phase, stage, `${prefix}.${stage}`, errors);
    }
    return modes;
}

/** Reads one profile object, reporting each bad field. */
function readProfile(value: unknown, key: string, errors: string[]): ParsedProfile | undefined {
    if (!isObject(value)) {
        errors.push(`"profiles.${key}" must be an object`);
        return undefined;
    }
    const profile: ParsedProfile = { match: [], deniedTools: [], modes: {} };
    if (value.extends !== undefined) {
        if (typeof value.extends === "string" && value.extends.trim().length > 0)
            profile.extends = value.extends.trim();
        else errors.push(`"profiles.${key}.extends" must be a profile name`);
    }
    if (value.match !== undefined) {
        if (!Array.isArray(value.match)) {
            errors.push(`"profiles.${key}.match" must be an array of globs`);
        } else {
            profile.match = unique(
                value.match
                    .filter((pattern): pattern is string => typeof pattern === "string")
                    .map((pattern) => pattern.trim())
                    .filter((pattern) => pattern.length > 0),
            );
        }
    }
    profile.deniedTools = readDeniedTools(value.deniedTools, `profiles.${key}.deniedTools`, errors);
    profile.modes = readStages(value, `profiles.${key}`, errors);
    return profile;
}

/** Parses one plan file, reporting every bad value and ignoring it. */
function readPlanFile(parsed: Record<string, unknown>, errors: string[]): PlanFile {
    const file: PlanFile = { deniedTools: [], profiles: {}, errors: [] };
    if (parsed.allowedTools !== undefined) {
        errors.push(`"allowedTools" is no longer supported; list tools to block in "deniedTools" or a profile`);
    }
    if (parsed.activeProfile !== undefined) {
        if (typeof parsed.activeProfile === "string" && parsed.activeProfile.trim().length > 0)
            file.activeProfile = parsed.activeProfile.trim();
        else errors.push(`"activeProfile" must be a profile name`);
    }
    file.deniedTools = readDeniedTools(parsed.deniedTools, "deniedTools", errors);
    if (parsed.modes !== undefined) {
        const modes = readStages(readPhase(parsed.modes, "modes", errors) ?? {}, "modes", errors);
        file.profiles.default = { match: [], deniedTools: [], modes };
    }
    if (parsed.profiles !== undefined) {
        if (!isObject(parsed.profiles)) {
            errors.push(`"profiles" must be an object`);
        } else {
            for (const [name, value] of Object.entries(parsed.profiles)) {
                if (name.endsWith("(local)")) {
                    errors.push(
                        `"profiles.${name}" must not end with "(local)"; local profiles get that suffix automatically`,
                    );
                    continue;
                }
                const profile = readProfile(value, name, errors);
                if (profile) file.profiles[name] = profile;
            }
        }
    }
    return file;
}

/** Reads one plan.json file. A missing or blank file means no configuration. */
export function loadPlanFile(path: string | undefined): PlanFile {
    const empty: PlanFile = { deniedTools: [], profiles: {}, errors: [] };
    if (!path || !existsSync(path)) return empty;
    let parsed: unknown;
    try {
        const content = readFileSync(path, "utf-8");
        if (content.trim().length === 0) return empty;
        parsed = JSON.parse(content);
    } catch (error) {
        return { ...empty, errors: [`${path}: ${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!isObject(parsed)) {
        return { ...empty, errors: [`${path}: expected a JSON object with a "profiles" object`] };
    }
    const errors: string[] = [];
    const file = readPlanFile(parsed, errors);
    file.errors = errors.map((error) => `${path}: ${error}`);
    return file;
}
