import assert from "node:assert/strict"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    loadPersistedAccountSource,
    parseOAuthResponse,
    saveAccountSource,
    syncAuthJson,
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

test("syncAuthJson: skips the write when auth.json is unparseable", () => {
    const authPath = join(dir, "auth.json")
    // A torn read (pi truncates auth.json before rewriting it) must never be
    // treated as "start fresh" -- that wipes every other provider.
    writeFileSync(authPath, '{"openai-codex": {"type": "oau', "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    assert.equal(
        readFileSync(authPath, "utf-8"),
        '{"openai-codex": {"type": "oau',
    )
})

test("syncAuthJson: skips the write when a JSON array is stored", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(authPath, "[]", "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    assert.equal(readFileSync(authPath, "utf-8"), "[]")
})

test("syncAuthJson: skips the write while pi holds the auth.json lock", () => {
    const authPath = join(dir, "auth.json")
    const stored = JSON.stringify({
        "openai-codex": { type: "oauth", access: "c" },
    })
    writeFileSync(authPath, stored, "utf-8")
    mkdirSync(`${authPath}.lock`)
    try {
        syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
        assert.equal(readFileSync(authPath, "utf-8"), stored)
    } finally {
        rmSync(`${authPath}.lock`, { recursive: true, force: true })
    }
})

test("syncAuthJson: takes and releases pi's auth.json lock", () => {
    const authPath = join(dir, "auth.json")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    assert.equal(existsSync(`${authPath}.lock`), false)
})

test("syncAuthJson: recovers a momentarily empty auth.json", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(authPath, "", "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
    }
    assert.equal(parsed.anthropic.access, "a")
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})
