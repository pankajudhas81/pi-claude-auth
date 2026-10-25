import assert from "node:assert/strict"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { afterEach, beforeEach, test, type TestContext } from "node:test"
import {
    forceRefreshActiveCredentials,
    getCachedCredentials,
    initAccounts,
    refreshIfNeeded,
    setActiveAccountSource,
} from "./credentials.ts"

// Every test runs against a throwaway HOME with a file-based Claude login and
// a stub `claude` on PATH, so no real credentials, Keychain item or CLI is
// touched.
let home = ""
let cliMarker = ""
const saved = { HOME: process.env.HOME, PATH: process.env.PATH }

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "pi-claude-auth-refresh-"))
    mkdirSync(join(home, ".claude"))
    mkdirSync(join(home, "bin"))
    cliMarker = join(home, "cli-invoked")
    process.env.HOME = home
    process.env.PATH = `${join(home, "bin")}${delimiter}${saved.PATH}`
})

afterEach(() => {
    process.env.HOME = saved.HOME
    process.env.PATH = saved.PATH
    rmSync(home, { recursive: true, force: true })
})

const credentialsPath = () => join(home, ".claude", ".credentials.json")

function storeLogin(
    accessToken: string,
    refreshToken: string,
    expiresAt: number,
) {
    writeFileSync(
        credentialsPath(),
        JSON.stringify({
            claudeAiOauth: { accessToken, refreshToken, expiresAt },
        }),
    )
    const credentials = { accessToken, refreshToken, expiresAt }
    initAccounts([{ label: "Claude", source: "file", credentials }])
    setActiveAccountSource("file")
}

/** A stub `claude` that records each run and optionally stores a new login. */
function stubClaude(sleepSeconds: number, newAccessToken?: string) {
    const write = newAccessToken
        ? `printf '%s' '${JSON.stringify({
              claudeAiOauth: {
                  accessToken: newAccessToken,
                  refreshToken: "cli-rotated",
                  expiresAt: Date.now() + 36_000_000,
              },
          })}' > "$HOME/.claude/.credentials.json"`
        : "exit 1"
    const script = join(home, "bin", "claude")
    writeFileSync(
        script,
        `#!/bin/sh\necho run >> "${cliMarker}"\nsleep ${sleepSeconds}\n${write}\n`,
    )
    chmodSync(script, 0o755)
}

function mockTokenEndpoint(t: TestContext, response: () => Response) {
    return t.mock.method(globalThis, "fetch", async () => response())
}

const cliRuns = () =>
    existsSync(cliMarker)
        ? readFileSync(cliMarker, "utf-8").split("\n").length - 1
        : 0

test("getCachedCredentials: never waits on a refresh", (t) => {
    // The token endpoint is blocked and the CLI is slow, as when the
    // reporter's pi hung for ~120s on every model-catalog refresh.
    mockTokenEndpoint(
        t,
        () => new Response("error code: 1010", { status: 403 }),
    )
    stubClaude(3)
    storeLogin("expired", "rt-sync", Date.now() - 1_000)

    const started = Date.now()
    assert.equal(getCachedCredentials(), null)
    assert.ok(Date.now() - started < 1_000)
})

test("forceRefreshActiveCredentials: returns when the caller stops waiting, the refresh lands later", async (t) => {
    mockTokenEndpoint(
        t,
        () => new Response("error code: 1010", { status: 403 }),
    )
    stubClaude(0.5, "from-cli")
    storeLogin("expired", "rt-bounded", Date.now() - 1_000)

    const started = Date.now()
    const early = await forceRefreshActiveCredentials(AbortSignal.timeout(100))
    assert.equal(early, null)
    assert.ok(Date.now() - started < 400)

    // The CLI refresh kept running in the background; a later call joins it
    // instead of starting a second run.
    const fresh = await refreshIfNeeded()
    assert.equal(fresh?.accessToken, "from-cli")
    assert.equal(cliRuns(), 1)
})

test("refreshIfNeeded: a rejected refresh token is not retried and skips the CLI", async (t) => {
    const endpoint = mockTokenEndpoint(
        t,
        () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    )
    stubClaude(0, "should-not-run")
    storeLogin("expired", "rt-dead", Date.now() - 1_000)

    assert.equal(await refreshIfNeeded(), null)
    assert.equal(await refreshIfNeeded(), null)
    assert.equal(endpoint.mock.callCount(), 1)
    assert.equal(cliRuns(), 0)
})

test("refreshIfNeeded: concurrent callers share one OAuth refresh and it is written back", async (t) => {
    const endpoint = mockTokenEndpoint(
        t,
        () =>
            new Response(
                JSON.stringify({
                    access_token: "from-oauth",
                    refresh_token: "rotated",
                    expires_in: 36_000,
                }),
            ),
    )
    stubClaude(0, "should-not-run")
    storeLogin("expired", "rt-shared", Date.now() - 1_000)

    const results = await Promise.all([refreshIfNeeded(), refreshIfNeeded()])
    assert.deepEqual(
        results.map((r) => r?.accessToken),
        ["from-oauth", "from-oauth"],
    )
    assert.equal(endpoint.mock.callCount(), 1)
    assert.equal(cliRuns(), 0)
    const stored = JSON.parse(readFileSync(credentialsPath(), "utf-8"))
    assert.equal(stored.claudeAiOauth.refreshToken, "rotated")
})
