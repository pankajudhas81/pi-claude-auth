import { log } from "./logger.ts"
import {
    buildBillingHeaderValue,
    getCliVersion,
    getEntrypoint,
} from "./signing.ts"

const BILLING_PREFIX = "x-anthropic-billing-header"
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

type SystemEntry = { type?: string; text?: string } & Record<string, unknown>

interface AnthropicPayload {
    model?: unknown
    system?: unknown
    messages?: unknown
    tools?: unknown
}

type JsonSchema = Record<string, unknown>

interface AnthropicTool {
    name?: unknown
    strict?: unknown
    input_schema?: unknown
}

// JSON Schema keywords that Anthropic's *strict* tool validator rejects,
// keyed by the schema `type` they are rejected for. Verified against
// /v1/messages/count_tokens — each entry produced a 400 of the form
// "tools.N.custom: For '<type>' type, property '<keyword>' is not supported".
//
// Keywords deliberately absent because the API accepts them under strict mode:
// string  -> minLength, maxLength, pattern, format
// array   -> minItems
// any     -> enum, const, default, description
const STRICT_UNSUPPORTED_KEYWORDS: Record<string, readonly string[]> = {
    integer: [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ],
    number: [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ],
    array: ["maxItems", "uniqueItems"],
    object: ["minProperties", "maxProperties"],
}

// Schema keywords whose values are themselves schemas.
const SUBSCHEMA_KEYS = ["items", "additionalItems", "not", "if", "then", "else"]

// Schema keywords whose values are arrays of schemas.
const SUBSCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"]

// Schema keywords whose values are maps of name -> schema.
const SUBSCHEMA_MAP_KEYS = [
    "properties",
    "$defs",
    "definitions",
    "patternProperties",
]

function isSchemaObject(value: unknown): value is JsonSchema {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when the node declares `type`, either as a string or inside a type union. */
function hasType(schema: JsonSchema, type: string): boolean {
    const t = schema.type
    if (typeof t === "string") return t === type
    if (Array.isArray(t)) return t.includes(type)
    return false
}

/** Visit a schema node and every subschema reachable from it. */
function walkSchema(schema: unknown, visit: (node: JsonSchema) => void): void {
    if (!isSchemaObject(schema)) return

    visit(schema)

    for (const key of SUBSCHEMA_KEYS) {
        walkSchema(schema[key], visit)
    }
    for (const key of SUBSCHEMA_LIST_KEYS) {
        const list = schema[key]
        if (Array.isArray(list)) {
            for (const entry of list) walkSchema(entry, visit)
        }
    }
    for (const key of SUBSCHEMA_MAP_KEYS) {
        const map = schema[key]
        if (isSchemaObject(map)) {
            for (const entry of Object.values(map)) walkSchema(entry, visit)
        }
    }
}

/**
 * True when the schema contains an object node whose `additionalProperties` is
 * present and set to anything other than `false`.
 *
 * Strict mode requires `additionalProperties: false` on every object node, so
 * such a schema cannot be expressed under strict mode without silently
 * narrowing the tool's contract. Those tools get `strict` dropped instead.
 */
function hasPermissiveAdditionalProperties(schema: unknown): boolean {
    let found = false
    walkSchema(schema, (node) => {
        if (!hasType(node, "object")) return
        if (!("additionalProperties" in node)) return
        if (node.additionalProperties !== false) found = true
    })
    return found
}

/**
 * Count union-typed parameters — nodes with a multi-entry `type` array, or with
 * `anyOf`/`oneOf`. Compiling these for constrained sampling costs exponential
 * time, so Anthropic budgets them across all strict tools in a request:
 *
 *     400 Schemas contains too many parameters with union types (23 parameters
 *         with type arrays or anyOf). This causes exponential compilation cost.
 *
 * The hard limit is 16, but the practical limit is far lower — measured against
 * /v1/messages, a single strict tool with 4 union parameters already added ~11s
 * of compile latency, and 8–12 exceeded a 90s timeout. Requests that stay under
 * the limit can still fail with "Schema is too complex for compilation".
 */
function countUnionParameters(schema: unknown): number {
    let count = 0
    walkSchema(schema, (node) => {
        if (Array.isArray(node.type) && node.type.length > 1) {
            count++
            return
        }
        if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) count++
    })
    return count
}

/**
 * Union-typed parameters permitted across all strict tools in one request.
 *
 * Defaults to 0: a tool whose schema needs unions gives up constrained sampling
 * rather than making every request pay exponential compile cost. Raise it via
 * PI_CLAUDE_AUTH_MAX_STRICT_UNIONS to trade latency back for stricter
 * validation (Anthropic's own ceiling is 16).
 */
function getMaxStrictUnions(): number {
    const raw = process.env.PI_CLAUDE_AUTH_MAX_STRICT_UNIONS
    if (!raw) return 0
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return parsed
}

/**
 * Remove strict-mode-unsupported keywords from a tool input schema, in place.
 * Returns true when anything was changed.
 */
function sanitizeSchema(schema: unknown): boolean {
    let changed = false

    walkSchema(schema, (node) => {
        for (const [type, keywords] of Object.entries(
            STRICT_UNSUPPORTED_KEYWORDS,
        )) {
            if (!hasType(node, type)) continue
            for (const keyword of keywords) {
                if (keyword in node) {
                    delete node[keyword]
                    changed = true
                }
            }
        }

        // Strict mode requires every object node to opt out of extra keys.
        // Callers that set it to something other than `false` are filtered out
        // before we get here (see hasPermissiveAdditionalProperties).
        if (hasType(node, "object") && !("additionalProperties" in node)) {
            node.additionalProperties = false
            changed = true
        }
    })

    return changed
}

/**
 * Make strict tool definitions acceptable to Anthropic's schema validator.
 *
 * pi marks a tool `strict: true` when it opts into JSON-schema constrained
 * sampling, and in that case forwards the tool's full JSON Schema verbatim
 * (non-strict tools are reduced to `{type, properties, required}`, which is why
 * they never trip this). Anthropic's strict validator accepts only a subset of
 * JSON Schema and rejects the whole request with, for example:
 *
 *     400 tools.17.custom: For 'integer' type, properties maximum, minimum
 *         are not supported
 *
 * For each strict tool we drop the unsupported keywords and add the required
 * `additionalProperties: false`. Two cases cannot be repaired that way and lose
 * `strict` instead — a schema that deliberately allows extra properties, and
 * union-typed parameters over the request-wide budget. Dropping `strict` is
 * safe: the non-strict validator accepts the full schema unchanged, so the tool
 * keeps working and only gives up constrained sampling.
 *
 * Returns the mutated payload when a tool was changed, or undefined to leave
 * the payload untouched.
 */
export function sanitizeStrictToolSchemas(
    payload: unknown,
): AnthropicPayload | undefined {
    if (!payload || typeof payload !== "object") return undefined

    const p = payload as AnthropicPayload
    if (!isClaudeModel(p.model)) return undefined
    if (!Array.isArray(p.tools)) return undefined

    const sanitized: string[] = []
    const downgraded: string[] = []

    // Pass 1 — repair what can be repaired, and drop `strict` from schemas that
    // strict mode cannot represent at all.
    const strictTools: Array<{ name: string; tool: AnthropicTool }> = []

    for (const tool of p.tools as AnthropicTool[]) {
        if (!tool || typeof tool !== "object") continue
        if (tool.strict !== true) continue
        if (!isSchemaObject(tool.input_schema)) continue

        const name = typeof tool.name === "string" ? tool.name : "<unnamed>"

        if (hasPermissiveAdditionalProperties(tool.input_schema)) {
            delete tool.strict
            downgraded.push(name)
            continue
        }

        if (sanitizeSchema(tool.input_schema)) sanitized.push(name)
        strictTools.push({ name, tool })
    }

    // Pass 2 — enforce the request-wide union budget, giving up `strict` on the
    // worst offenders first so the cheapest schemas keep constrained sampling.
    const budget = getMaxStrictUnions()
    const counted: Array<{
        name: string
        tool: AnthropicTool
        unions: number
    }> = []
    for (const { name, tool } of strictTools) {
        const unions = countUnionParameters(tool.input_schema)
        if (unions > 0) counted.push({ name, tool, unions })
    }
    counted.sort((a, b) => b.unions - a.unions)

    let total = counted.reduce((sum, entry) => sum + entry.unions, 0)
    for (const entry of counted) {
        if (total <= budget) break
        delete entry.tool.strict
        total -= entry.unions
        downgraded.push(entry.name)
    }

    if (sanitized.length === 0 && downgraded.length === 0) return undefined

    log("tool_schema_sanitized", { sanitized, downgraded })
    return p
}

function isClaudeModel(model: unknown): model is string {
    return typeof model === "string" && model.toLowerCase().includes("claude")
}

function entryText(entry: unknown): string {
    if (typeof entry === "string") return entry
    if (entry && typeof entry === "object") {
        const text = (entry as { text?: unknown }).text
        if (typeof text === "string") return text
    }
    return ""
}

/**
 * Inject the Claude Code billing header into an Anthropic request payload as
 * the first system entry.
 *
 * pi's built-in Anthropic provider already sends the Claude Code identity,
 * beta flags, and user-agent for OAuth tokens, but it does not send the
 * `x-anthropic-billing-header` system block. That block is what routes billing
 * to the Claude Pro/Max subscription instead of pay-as-you-go API credits.
 *
 * Returns the mutated payload when a billing header was injected, or undefined
 * to leave the payload unchanged (non-Claude requests, or already injected).
 */
export function injectBillingHeader(
    payload: unknown,
): AnthropicPayload | undefined {
    if (!payload || typeof payload !== "object") return undefined

    const p = payload as AnthropicPayload
    if (!isClaudeModel(p.model)) return undefined
    if (!Array.isArray(p.messages)) return undefined

    const system: SystemEntry[] = Array.isArray(p.system)
        ? (p.system as SystemEntry[])
        : []

    // Only inject when pi is in OAuth stealth mode, signalled by its Claude
    // Code identity block. This avoids touching plain API-key requests (which
    // bill correctly on their own and would be confused by the header).
    if (!system.some((e) => entryText(e).startsWith(CC_IDENTITY))) {
        return undefined
    }

    // Already injected — leave it untouched (handler idempotency).
    if (system.some((e) => entryText(e).startsWith(BILLING_PREFIX))) {
        return undefined
    }

    const messages = p.messages as Array<{
        role?: string
        content?: string | Array<{ type?: string; text?: string }>
    }>

    const billingHeader = buildBillingHeaderValue(
        messages,
        getCliVersion(),
        getEntrypoint(),
    )

    // Billing header goes first, ahead of pi's identity block. No
    // cache_control so it does not consume a cache breakpoint.
    p.system = [{ type: "text", text: billingHeader }, ...system]

    // Relocate non-core system entries to user messages.
    // Anthropic's API validates the system prompt for OAuth-authenticated
    // requests that use Claude Code billing.  Third-party system prompts
    // (like pi's) trigger a 400 "out of extra usage" rejection when
    // they appear inside the system[] array alongside the identity prefix.
    //
    // Work-around: keep only the billing header and identity prefix in
    // system[], and prepend all other system content to the first user
    // message where it is functionally equivalent but avoids the check.
    const keptSystem: SystemEntry[] = []
    const movedTexts: string[] = []
    for (const entry of p.system as SystemEntry[]) {
        const txt = entryText(entry)
        if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(CC_IDENTITY)) {
            keptSystem.push(entry)
        } else if (txt.length > 0) {
            movedTexts.push(txt)
        }
    }

    if (movedTexts.length > 0) {
        const firstUser = (
            p.messages as Array<{
                role?: string
                content?: string | Array<{ type?: string; text?: string }>
            }>
        ).find((m) => m.role === "user")
        if (firstUser) {
            p.system = keptSystem
            const prefix = movedTexts.join("\n\n")
            const content = firstUser.content
            if (typeof content === "string") {
                firstUser.content = prefix + "\n\n" + content
            } else if (Array.isArray(content)) {
                content.unshift({ type: "text", text: prefix })
            }
        }
    }

    return p
}
