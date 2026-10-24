import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test } from "node:test"
import {
    loadPersistedAccountSource,
    parseOAuthResponse,
    refreshIfNeeded,
    saveAccountSource,
    syncAuthJson,
    type ClaudeAccount,
} from "./credentials.ts"

let dir = ""
let prevEnv: string | undefined

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"))
    process.env.PI_CODING_AGENT_DIR = dir
})

afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
    mock.restoreAll()
    syncBuiltinESMExports()
})

test("parseOAuthResponse: maps a valid token response", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 100,
        }),
        "old-refresh",
        1_000,
    )
    assert.ok(creds)
    assert.equal(creds.accessToken, "new-access")
    assert.equal(creds.refreshToken, "new-refresh")
    assert.equal(creds.expiresAt, 1_000 + 100 * 1000)
})

test("parseOAuthResponse: keeps current refresh token when not rotated", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({ access_token: "a", expires_in: 10 }),
        "keep-me",
        0,
    )
    assert.ok(creds)
    assert.equal(creds.refreshToken, "keep-me")
})

test("parseOAuthResponse: defaults expires_in to 36000s", () => {
    const creds = parseOAuthResponse(
        JSON.stringify({ access_token: "a" }),
        "r",
        0,
    )
    assert.ok(creds)
    assert.equal(creds.expiresAt, 36_000 * 1000)
})

test("parseOAuthResponse: returns null without an access token", () => {
    assert.equal(parseOAuthResponse(JSON.stringify({ error: "x" }), "r"), null)
    assert.equal(parseOAuthResponse("not json", "r"), null)
})

test("syncAuthJson: writes a pi oauth entry under anthropic", () => {
    syncAuthJson({
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt: 12345,
    })
    const raw = readFileSync(join(dir, "auth.json"), "utf-8")
    const parsed = JSON.parse(raw) as {
        anthropic: {
            type: string
            access: string
            refresh: string
            expires: number
        }
    }
    assert.deepEqual(parsed.anthropic, {
        type: "oauth",
        access: "acc",
        refresh: "ref",
        expires: 12345,
    })
})

test("syncAuthJson: preserves other providers in auth.json", () => {
    const authPath = join(dir, "auth.json")
    // Seed an unrelated provider, then sync anthropic on top of it.
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    syncAuthJson({ accessToken: "a2", refreshToken: "r2", expiresAt: 2 })
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { type: string; key: string }
    }
    assert.equal(parsed.anthropic.access, "a2")
    assert.deepEqual(parsed.openai, { type: "api_key", key: "sk-test" })
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})

function keychainAccount(): ClaudeAccount {
    return {
        label: "Claude",
        source: "Claude Code-credentials",
        credentials: {
            accessToken: "old-access",
            refreshToken: "old-refresh",
            expiresAt: Date.now() + 60 * 60 * 1000,
        },
    }
}

// keychain.ts reads entries through `security`; mocking execSync stands in
// for the macOS Keychain.
function mockKeychain(impl: () => string): void {
    mock.method(childProcess, "execSync", impl)
    syncBuiltinESMExports()
}

test("refreshIfNeeded: picks up keychain tokens rotated by another process", () => {
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000
    mockKeychain(() =>
        JSON.stringify({
            claudeAiOauth: {
                accessToken: "new-access",
                refreshToken: "new-refresh",
                expiresAt,
            },
        }),
    )

    const creds = refreshIfNeeded(keychainAccount())
    assert.equal(creds?.accessToken, "new-access")
    assert.equal(creds?.refreshToken, "new-refresh")
    assert.equal(creds?.expiresAt, expiresAt)
})

test("refreshIfNeeded: keeps in-memory credentials when the keychain can't be read", () => {
    mockKeychain(() => {
        throw Object.assign(new Error("keychain locked"), { status: 36 })
    })

    const creds = refreshIfNeeded(keychainAccount())
    assert.equal(creds?.accessToken, "old-access")
})
