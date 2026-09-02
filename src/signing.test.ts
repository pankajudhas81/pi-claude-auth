import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, test } from "node:test"
import {
    buildBillingHeaderValue,
    buildUserAgent,
    computeCch,
    computeVersionSuffix,
    extractFirstUserMessageText,
} from "./signing.ts"

const prevUa = process.env.ANTHROPIC_USER_AGENT
const prevVer = process.env.ANTHROPIC_CLI_VERSION
const prevEntry = process.env.CLAUDE_CODE_ENTRYPOINT

afterEach(() => {
    restore("ANTHROPIC_USER_AGENT", prevUa)
    restore("ANTHROPIC_CLI_VERSION", prevVer)
    restore("CLAUDE_CODE_ENTRYPOINT", prevEntry)
})

function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
}

test("extractFirstUserMessageText: string content", () => {
    assert.equal(
        extractFirstUserMessageText([{ role: "user", content: "hello" }]),
        "hello",
    )
})

test("extractFirstUserMessageText: first text block of array content", () => {
    assert.equal(
        extractFirstUserMessageText([
            {
                role: "user",
                content: [
                    { type: "image" },
                    { type: "text", text: "from block" },
                ],
            },
        ]),
        "from block",
    )
})

test("extractFirstUserMessageText: no user message", () => {
    assert.equal(
        extractFirstUserMessageText([{ role: "assistant", content: "hi" }]),
        "",
    )
})

test("computeCch: first 5 hex chars of sha256", () => {
    const expected = createHash("sha256")
        .update("hello")
        .digest("hex")
        .slice(0, 5)
    assert.equal(computeCch("hello"), expected)
})

test("computeVersionSuffix: is deterministic and 3 hex chars", () => {
    const a = computeVersionSuffix("a message here", "2.1.258")
    const b = computeVersionSuffix("a message here", "2.1.258")
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{3}$/)
})

test("buildBillingHeaderValue: well-formed header", () => {
    const header = buildBillingHeaderValue(
        [{ role: "user", content: "hi there" }],
        "2.1.258",
        "sdk-cli",
    )
    assert.match(
        header,
        /^x-anthropic-billing-header: cc_version=2\.1\.258\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/,
    )
})

test("buildUserAgent: default Claude Code form", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.ANTHROPIC_CLI_VERSION
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    assert.equal(buildUserAgent(), "claude-cli/2.1.258 (external, sdk-cli)")
})

test("buildUserAgent: honors version and entrypoint overrides", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli"
    assert.equal(buildUserAgent(), "claude-cli/9.9.9 (external, cli)")
})

test("buildUserAgent: full override wins", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"
    assert.equal(buildUserAgent(), "custom-agent/1.0")
})
