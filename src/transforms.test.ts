import assert from "node:assert/strict"
import { test } from "node:test"
import { injectBillingHeader, sanitizeStrictToolSchemas } from "./transforms.ts"

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

function claudePayload() {
    return {
        model: "claude-haiku-4-5",
        system: [{ type: "text", text: IDENTITY }],
        messages: [{ role: "user", content: "hello world" }],
    }
}

test("injectBillingHeader: prepends billing block when identity present", () => {
    const payload = claudePayload()
    const out = injectBillingHeader(payload)
    assert.ok(out)
    const system = out.system as Array<{ text: string }>
    assert.equal(system.length, 2)
    assert.match(system[0].text, /^x-anthropic-billing-header:/)
    assert.equal(system[1].text, IDENTITY)
})

test("injectBillingHeader: undefined without the identity block", () => {
    const payload = {
        model: "claude-haiku-4-5",
        system: [{ type: "text", text: "some other system prompt" }],
        messages: [{ role: "user", content: "hi" }],
    }
    assert.equal(injectBillingHeader(payload), undefined)
})

test("injectBillingHeader: undefined for non-Claude models", () => {
    const payload = {
        model: "gpt-4o",
        system: [{ type: "text", text: IDENTITY }],
        messages: [{ role: "user", content: "hi" }],
    }
    assert.equal(injectBillingHeader(payload), undefined)
})

test("injectBillingHeader: idempotent when already injected", () => {
    const payload = claudePayload()
    const first = injectBillingHeader(payload)
    assert.ok(first)
    // Second pass over the already-injected payload is a no-op.
    assert.equal(injectBillingHeader(first), undefined)
})

test("injectBillingHeader: undefined for non-object payloads", () => {
    assert.equal(injectBillingHeader(null), undefined)
    assert.equal(injectBillingHeader("string"), undefined)
    assert.equal(injectBillingHeader(42), undefined)
})

test("injectBillingHeader: undefined when messages are missing", () => {
    const payload = {
        model: "claude-haiku-4-5",
        system: [{ type: "text", text: IDENTITY }],
    }
    assert.equal(injectBillingHeader(payload), undefined)
})

test("injectBillingHeader: relocates non-core system entries to first user message", () => {
    const payload = {
        model: "claude-sonnet-4-6",
        system: [
            { type: "text", text: IDENTITY },
            { type: "text", text: "You are a helpful coding agent." },
            { type: "text", text: "Always respond in English." },
        ],
        messages: [{ role: "user", content: "hello" }],
    }
    const out = injectBillingHeader(payload)
    assert.ok(out)
    const system = out.system as Array<{ text: string }>
    // Only billing header + identity should remain in system[]
    assert.equal(system.length, 2)
    assert.match(system[0].text, /^x-anthropic-billing-header:/)
    assert.equal(system[1].text, IDENTITY)
    // Non-core entries should be prepended to first user message
    const msgs = out.messages as Array<{ role: string; content: string }>
    assert.ok(msgs[0].content.includes("You are a helpful coding agent."))
    assert.ok(msgs[0].content.includes("Always respond in English."))
    assert.ok(msgs[0].content.includes("hello"))
})

function strictTool(name: string, properties: Record<string, unknown>) {
    return {
        type: "custom",
        name,
        description: "test tool",
        strict: true,
        input_schema: {
            type: "object",
            properties,
            required: [],
            additionalProperties: false,
        },
    }
}

function toolPayload(tools: unknown[]) {
    return {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
        tools,
    }
}

function schemaOf(payload: { tools?: unknown }, index = 0) {
    const tool = (payload.tools as Array<Record<string, unknown>>)[index]
    return tool.input_schema as Record<string, Record<string, unknown>>
}

test("sanitizeStrictToolSchemas: strips numeric keywords rejected under strict", () => {
    const payload = toolPayload([
        strictTool("t", {
            count: { type: "integer", minimum: 0, maximum: 10 },
            ratio: { type: "number", exclusiveMinimum: 0, multipleOf: 0.5 },
        }),
    ])
    assert.ok(sanitizeStrictToolSchemas(payload))

    const props = schemaOf(payload).properties
    assert.deepEqual(props.count, { type: "integer" })
    assert.deepEqual(props.ratio, { type: "number" })
})

test("sanitizeStrictToolSchemas: keeps keywords strict mode accepts", () => {
    const payload = toolPayload([
        strictTool("t", {
            name: {
                type: "string",
                minLength: 1,
                maxLength: 8,
                pattern: "^a+$",
            },
            tags: { type: "array", items: { type: "string" }, minItems: 1 },
            level: { type: "integer", enum: [1, 2], description: "level" },
        }),
    ])
    // Only the required additionalProperties fixups should apply here.
    sanitizeStrictToolSchemas(payload)

    const props = schemaOf(payload).properties
    assert.deepEqual(props.name, {
        type: "string",
        minLength: 1,
        maxLength: 8,
        pattern: "^a+$",
    })
    assert.deepEqual(props.tags, {
        type: "array",
        items: { type: "string" },
        minItems: 1,
    })
    assert.deepEqual(props.level, {
        type: "integer",
        enum: [1, 2],
        description: "level",
    })
})

test("sanitizeStrictToolSchemas: strips array and object keywords", () => {
    const payload = toolPayload([
        strictTool("t", {
            tags: {
                type: "array",
                items: { type: "string" },
                maxItems: 3,
                uniqueItems: true,
            },
            opts: {
                type: "object",
                properties: {},
                minProperties: 1,
                maxProperties: 4,
                additionalProperties: false,
            },
        }),
    ])
    assert.ok(sanitizeStrictToolSchemas(payload))

    const props = schemaOf(payload).properties
    assert.deepEqual(props.tags, { type: "array", items: { type: "string" } })
    assert.deepEqual(props.opts, {
        type: "object",
        properties: {},
        additionalProperties: false,
    })
})

test("sanitizeStrictToolSchemas: adds additionalProperties to nested objects", () => {
    const payload = toolPayload([
        strictTool("t", {
            nested: { type: "object", properties: { a: { type: "string" } } },
        }),
    ])
    assert.ok(sanitizeStrictToolSchemas(payload))

    assert.equal(
        (schemaOf(payload).properties.nested as Record<string, unknown>)
            .additionalProperties,
        false,
    )
})

test("sanitizeStrictToolSchemas: recurses into $defs, anyOf and array items", () => {
    const payload = toolPayload([
        strictTool("t", {
            node: { $ref: "#/$defs/N" },
            list: { type: "array", items: { type: "integer", minimum: 1 } },
        }),
    ])
    const schema = schemaOf(payload)
    schema.$defs = { N: { type: "integer", minimum: 1, maximum: 3 } }
    assert.ok(sanitizeStrictToolSchemas(payload))

    assert.deepEqual(schema.$defs.N, { type: "integer" })
    assert.deepEqual(
        (schemaOf(payload).properties.list as Record<string, unknown>).items,
        { type: "integer" },
    )
})

test("sanitizeStrictToolSchemas: leaves non-strict tools untouched", () => {
    const tool = {
        name: "t",
        description: "d",
        input_schema: {
            type: "object",
            properties: { count: { type: "integer", minimum: 0 } },
        },
    }
    const payload = toolPayload([tool])
    assert.equal(sanitizeStrictToolSchemas(payload), undefined)
    assert.deepEqual(tool.input_schema.properties.count, {
        type: "integer",
        minimum: 0,
    })
})

test("sanitizeStrictToolSchemas: drops strict when extra properties are allowed", () => {
    const tool = strictTool("t", { a: { type: "string" } })
    tool.input_schema.additionalProperties = true
    const payload = toolPayload([tool])
    assert.ok(sanitizeStrictToolSchemas(payload))

    assert.equal(tool.strict, undefined)
    // The schema itself is preserved — only constrained sampling is given up.
    assert.equal(tool.input_schema.additionalProperties, true)
})

test("sanitizeStrictToolSchemas: drops strict from union-typed tools", () => {
    const typeList = strictTool("typeList", {
        a: { type: ["string", "null"] },
    })
    const anyOf = strictTool("anyOf", {
        b: { anyOf: [{ type: "string" }, { type: "integer" }] },
    })
    const plain = strictTool("plain", { c: { type: "string" } })
    assert.ok(sanitizeStrictToolSchemas(toolPayload([typeList, anyOf, plain])))

    assert.equal(typeList.strict, undefined)
    assert.equal(anyOf.strict, undefined)
    // Union-free schemas keep constrained sampling.
    assert.equal(plain.strict, true)
})

test("sanitizeStrictToolSchemas: honours the union budget, worst offender first", () => {
    process.env.PI_CLAUDE_AUTH_MAX_STRICT_UNIONS = "2"
    try {
        const heavy = strictTool("heavy", {
            a: { type: ["string", "null"] },
            b: { type: ["string", "null"] },
            c: { type: ["string", "null"] },
        })
        const light = strictTool("light", { a: { type: ["string", "null"] } })
        assert.ok(sanitizeStrictToolSchemas(toolPayload([heavy, light])))

        // 4 unions total, budget 2: dropping `heavy` alone brings it to 1.
        assert.equal(heavy.strict, undefined)
        assert.equal(light.strict, true)
    } finally {
        delete process.env.PI_CLAUDE_AUTH_MAX_STRICT_UNIONS
    }
})

test("sanitizeStrictToolSchemas: idempotent and inert on unrelated payloads", () => {
    const payload = toolPayload([
        strictTool("t", { count: { type: "integer", minimum: 0 } }),
    ])
    assert.ok(sanitizeStrictToolSchemas(payload))
    assert.equal(sanitizeStrictToolSchemas(payload), undefined)

    assert.equal(
        sanitizeStrictToolSchemas({ ...payload, model: "gpt-4o" }),
        undefined,
    )
    assert.equal(
        sanitizeStrictToolSchemas({ model: "claude-haiku-4-5", messages: [] }),
        undefined,
    )
    assert.equal(sanitizeStrictToolSchemas(null), undefined)
})
