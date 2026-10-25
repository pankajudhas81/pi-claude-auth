import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
    buildBillingHeaderValue,
    buildUserAgent,
    CC_VERSION,
    computeCch,
    computeVersionSuffix,
    detectInstalledCliVersion,
    extractFirstUserMessageText,
    getCliVersion,
    parseClaudeVersion,
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
    const a = computeVersionSuffix("a message here", "2.1.160")
    const b = computeVersionSuffix("a message here", "2.1.160")
    assert.equal(a, b)
    assert.match(a, /^[0-9a-f]{3}$/)
})

test("buildBillingHeaderValue: well-formed header", () => {
    const header = buildBillingHeaderValue(
        [{ role: "user", content: "hi there" }],
        "2.1.160",
        "sdk-cli",
    )
    assert.match(
        header,
        /^x-anthropic-billing-header: cc_version=2\.1\.160\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/,
    )
})

test("buildUserAgent: default Claude Code form", () => {
    delete process.env.ANTHROPIC_USER_AGENT
    delete process.env.ANTHROPIC_CLI_VERSION
    delete process.env.CLAUDE_CODE_ENTRYPOINT
    assert.equal(
        buildUserAgent(),
        `claude-cli/${CC_VERSION} (external, sdk-cli)`,
    )
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

test("parseClaudeVersion: takes only a well-formed leading version", () => {
    assert.equal(parseClaudeVersion("2.1.310 (Claude Code)\n"), "2.1.310")
    assert.equal(parseClaudeVersion("2.1.310"), "2.1.310")
    assert.equal(parseClaudeVersion(""), null)
    assert.equal(parseClaudeVersion("error: unknown option"), null)
    assert.equal(parseClaudeVersion("2.1.310-evil\r\nx-injected: 1"), null)
})

/** Run `fn` with only a stub `claude` printing `output` on PATH. */
async function withClaude(
    output: string | null,
    fn: () => Promise<void>,
): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-cli-"))
    const prevPath = process.env.PATH
    if (output !== null) {
        const bin = join(dir, "claude")
        writeFileSync(bin, `#!/bin/sh\necho '${output}'\n`)
        chmodSync(bin, 0o755)
    }
    process.env.PATH = dir
    try {
        await fn()
    } finally {
        process.env.PATH = prevPath
        rmSync(dir, { recursive: true, force: true })
    }
}

test("getCliVersion: the installed claude wins only when newer than the floor", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell stub")
    delete process.env.ANTHROPIC_CLI_VERSION

    await withClaude("9.0.0 (Claude Code)", async () => {
        assert.equal(await detectInstalledCliVersion(), "9.0.0")
        assert.equal(getCliVersion(), "9.0.0")
        process.env.ANTHROPIC_CLI_VERSION = "1.2.3"
        assert.equal(getCliVersion(), "1.2.3")
        delete process.env.ANTHROPIC_CLI_VERSION
    })
    // An outdated install would be rejected by newer models; keep the floor.
    await withClaude("2.0.0 (Claude Code)", async () => {
        assert.equal(await detectInstalledCliVersion(), "2.0.0")
        assert.equal(getCliVersion(), CC_VERSION)
    })
    await withClaude(null, async () => {
        assert.equal(await detectInstalledCliVersion(), null)
        assert.equal(getCliVersion(), CC_VERSION)
    })
})
