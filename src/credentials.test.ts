import assert from "node:assert/strict"
import childProcess from "node:child_process"
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, mock, test, type TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import {
    forceRefreshActiveCredentials,
    getCachedCredentials,
    initAccounts,
    loadPersistedAccountSource,
    parseOAuthResponse,
    refreshViaOAuth,
    saveAccountSource,
    setActiveAccountSource,
    syncAuthJson,
} from "./credentials.ts"

let dir = ""
let prevEnv: string | undefined
let subprocessCalls = 0

beforeEach(() => {
    prevEnv = process.env.PI_CODING_AGENT_DIR
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"))
    process.env.PI_CODING_AGENT_DIR = dir
    initAccounts([])
    subprocessCalls = 0
})

afterEach(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
    if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevEnv
    rmSync(dir, { recursive: true, force: true })
    assert.equal(
        subprocessCalls,
        0,
        "Credential refresh must not launch a subprocess",
    )
})

function fileAccount(t: TestContext): string {
    const path = join(dir, ".claude", ".credentials.json")
    mkdirSync(join(dir, ".claude"))
    const creds = {
        accessToken: "expired",
        refreshToken: "old-refresh",
        expiresAt: 1,
    }
    writeFileSync(
        path,
        JSON.stringify({
            claudeAiOauth: { ...creds, subscriptionType: "max" },
        }),
    )
    t.mock.method(os, "homedir", () => dir)
    for (const method of ["execSync", "execFileSync"] as const) {
        t.mock.method(childProcess, method, () => {
            subprocessCalls++
            assert.fail("Credential refresh must not launch a subprocess")
        })
    }
    syncBuiltinESMExports()
    initAccounts([{ label: "Claude Max", source: "file", credentials: creds }])
    setActiveAccountSource("file")
    return path
}

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

test("syncAuthJson: skips the write when auth.json is malformed", () => {
    const authPath = join(dir, "auth.json")
    // Simulate a torn read: another process is mid-write.
    const torn = '{ "openai-codex": { "type": "oauth", "acc'
    writeFileSync(authPath, torn, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    // File must be left untouched, not rebuilt from scratch.
    assert.equal(readFileSync(authPath, "utf-8"), torn)
})

test("syncAuthJson: no-op when the anthropic entry is already in sync", () => {
    const authPath = join(dir, "auth.json")
    const creds = { accessToken: "acc", refreshToken: "ref", expiresAt: 5 }
    syncAuthJson(creds)
    // Something else edits an unrelated provider between syncs. Written
    // compact, so any rewrite (which pretty-prints) changes the bytes.
    const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
        string,
        unknown
    >
    parsed["openai-codex"] = { type: "oauth", access: "x" }
    const compact = JSON.stringify(parsed)
    writeFileSync(authPath, compact, "utf-8")
    // A repeat sync with identical creds must not rewrite the file.
    syncAuthJson(creds)
    assert.equal(readFileSync(authPath, "utf-8"), compact)
})

test("syncAuthJson: leaves no temp files behind", () => {
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"))
    assert.deepEqual(leftovers, [])
})

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})

test("getCachedCredentials: expired credentials do not start OAuth or Claude", (t) => {
    fileAccount(t)
    const fetch = t.mock.method(globalThis, "fetch", () => {
        assert.fail(
            "Synchronous API-key resolution must not perform network I/O",
        )
    })
    assert.equal(getCachedCredentials(), null)
    assert.equal(getCachedCredentials(), null)
    assert.equal(fetch.mock.callCount(), 0)
})

test("async refresh: rotates tokens, preserves metadata, and populates cache", async (t) => {
    const path = fileAccount(t)
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(url, "https://claude.ai/v1/oauth/token")
        assert.equal(options?.method, "POST")
        const body = new URLSearchParams(options?.body as string)
        assert.equal(body.get("refresh_token"), "old-refresh")
        assert.ok(options?.signal)
        return new Response(
            JSON.stringify({
                access_token: "new",
                refresh_token: "rotated",
                expires_in: 3600,
            }),
        )
    })
    const creds = await forceRefreshActiveCredentials()
    assert.equal(creds?.accessToken, "new")
    assert.equal(getCachedCredentials()?.refreshToken, "rotated")
    const stored = JSON.parse(readFileSync(path, "utf-8")).claudeAiOauth
    assert.equal(stored.refreshToken, "rotated")
    assert.equal(stored.subscriptionType, "max")
})

test("rejected refresh token: failure is cached until credentials change", async (t) => {
    const path = fileAccount(t)
    const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
        const token = new URLSearchParams(options?.body as string).get(
            "refresh_token",
        )
        return token === "old-refresh"
            ? new Response('{"error":"invalid_grant"}', { status: 400 })
            : new Response(
                  '{"access_token":"recovered","refresh_token":"rotated","expires_in":3600}',
              )
    })
    assert.equal(await forceRefreshActiveCredentials(), null)
    assert.equal(await forceRefreshActiveCredentials(), null)
    assert.equal(fetch.mock.callCount(), 1)
    writeFileSync(
        path,
        JSON.stringify({
            accessToken: "expired",
            refreshToken: "new-login-refresh",
            expiresAt: 1,
        }),
    )
    assert.equal(
        (await forceRefreshActiveCredentials())?.accessToken,
        "recovered",
    )
    assert.equal(fetch.mock.callCount(), 2)
})

test("concurrent refresh: one OAuth request without blocking the event loop", async (t) => {
    fileAccount(t)
    let complete!: (response: Response) => void
    const fetch = t.mock.method(
        globalThis,
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                complete = resolve
            }),
    )
    const first = forceRefreshActiveCredentials()
    const second = forceRefreshActiveCredentials()
    await setImmediate()
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(getCachedCredentials(), null)
    complete(
        new Response(
            '{"access_token":"new","refresh_token":"rotated","expires_in":3600}',
        ),
    )
    const results = await Promise.all([first, second])
    assert.deepEqual(results[0], results[1])
    assert.equal(results[0]?.accessToken, "new")
})

test("refresh timeout: uses a five-second abort signal and caches failure", async (t) => {
    fileAccount(t)
    t.mock.method(AbortSignal, "timeout", (ms) => {
        assert.equal(ms, 5_000)
        return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"))
    })
    const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
        options?.signal?.throwIfAborted()
        assert.fail("Timeout signal must abort the request")
    })
    assert.equal(await forceRefreshActiveCredentials(), null)
    assert.equal(await forceRefreshActiveCredentials(), null)
    assert.equal(fetch.mock.callCount(), 1)
})

test("caller abort: cancels OAuth and does not poison the retry cache", async (t) => {
    fileAccount(t)
    const controller = new AbortController()
    const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
        return await new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener(
                "abort",
                () => reject(options.signal?.reason),
                { once: true },
            )
        })
    })
    const pending = forceRefreshActiveCredentials(controller.signal)
    controller.abort()
    await assert.rejects(pending, { name: "AbortError" })
    fetch.mock.mockImplementation(
        async () => new Response('{"access_token":"new","expires_in":3600}'),
    )
    assert.equal((await forceRefreshActiveCredentials())?.accessToken, "new")
    assert.equal(fetch.mock.callCount(), 2)
})

test("transient refresh failure: retries after the cooldown", async (t) => {
    let now = 1_000
    t.mock.method(Date, "now", () => now)
    const fetch = t.mock.method(
        globalThis,
        "fetch",
        async () => new Response("", { status: 503 }),
    )
    assert.equal(await refreshViaOAuth("temporary"), null)
    assert.equal(await refreshViaOAuth("temporary"), null)
    assert.equal(fetch.mock.callCount(), 1)
    now += 30_001
    fetch.mock.mockImplementation(
        async () => new Response('{"access_token":"new","expires_in":3600}'),
    )
    assert.equal((await refreshViaOAuth("temporary"))?.accessToken, "new")
    assert.equal(fetch.mock.callCount(), 2)
})
