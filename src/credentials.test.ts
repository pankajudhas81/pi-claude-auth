import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs, {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { lockSync } from "proper-lockfile"
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

test("syncAuthJson: never wipes a malformed auth.json, keeps a backup instead", () => {
    const authPath = join(dir, "auth.json")
    // Truncated JSON with another provider's credential inside.
    const corrupt = '{"openai": {"type": "api_key", "key": "sk-test"'
    writeFileSync(authPath, corrupt, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    // The corrupt file must be left exactly as it was, not reset to {} +
    // anthropic (which wiped every other provider's credentials).
    assert.equal(readFileSync(authPath, "utf-8"), corrupt)
    const backups = readdirSync(dir).filter((f) =>
        f.startsWith("auth.json.corrupt-"),
    )
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(dir, backups[0]), "utf-8"), corrupt)
})

test("syncAuthJson: does not write while another holder has the auth.json lock", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(
        authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }),
        "utf-8",
    )
    // Hold the lock the same way pi does while writing credentials.
    const release = lockSync(authPath, { realpath: false })
    let threwLocked = false
    try {
        syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    } catch (err) {
        threwLocked = (err as NodeJS.ErrnoException)?.code === "ELOCKED"
    }
    release()
    // Losing the lock contention race must throw, not silently overwrite.
    assert.equal(threwLocked, true)
    const held = JSON.parse(readFileSync(authPath, "utf-8")) as {
        openai: { key: string }
    }
    assert.equal(held.openai.key, "sk-test")
    // Once the lock is free, the sync works and preserves the other provider.
    syncAuthJson({ accessToken: "a2", refreshToken: "r2", expiresAt: 2 })
    const after = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { key: string }
    }
    assert.equal(after.anthropic.access, "a2")
    assert.equal(after.openai.key, "sk-test")
})

test("syncAuthJson: syncs a BOM-prefixed auth.json instead of treating it as corrupt", () => {
    const authPath = join(dir, "auth.json")
    writeFileSync(
        authPath,
        `\uFEFF${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } })}`,
        "utf-8",
    )
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    const after = JSON.parse(readFileSync(authPath, "utf-8")) as {
        anthropic: { access: string }
        openai: { key: string }
    }
    assert.equal(after.anthropic.access, "a")
    assert.equal(after.openai.key, "sk-test")
    // No corrupt backup should be created for a merely BOM-prefixed file.
    assert.equal(
        readdirSync(dir).filter((f) => f.startsWith("auth.json.corrupt-"))
            .length,
        0,
    )
})

test("syncAuthJson: does not pile up identical corrupt backups", () => {
    const authPath = join(dir, "auth.json")
    const corrupt = '{"openai": {"type": "api_key", "key": "sk-test"'
    writeFileSync(authPath, corrupt, "utf-8")
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
    assert.equal(
        readdirSync(dir).filter((f) => f.startsWith("auth.json.corrupt-"))
            .length,
        1,
    )
})

for (const raw of ["", " \n\t", "\uFEFF  ", "[]", "null", "42", '"text"']) {
    test(`syncAuthJson: preserves invalid content ${JSON.stringify(raw)}`, () => {
        const authPath = join(dir, "auth.json")
        writeFileSync(authPath, raw)
        syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
        assert.equal(readFileSync(authPath, "utf-8"), raw)
        assert.equal(existsSync(`${authPath}.lock`), false)
        const backups = readdirSync(dir).filter((name) =>
            name.startsWith("auth.json.corrupt-"),
        )
        assert.equal(backups.length, 1)
        assert.equal(readFileSync(join(dir, backups[0]), "utf-8"), raw)
    })
}

for (const state of ["missing", "truncated"]) {
    test(
        `syncAuthJson: interoperates with a separate proper-lockfile writer, ${state}`,
        { timeout: 10_000 },
        async () => {
            const authPath = join(dir, "auth.json")
            // IPC holds the writer inside its critical section until contention
            // has been checked. No scheduler timing or real credentials involved.
            const child = spawn(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    `
            import { writeFileSync } from 'node:fs';
            import { lockSync } from 'proper-lockfile';
            const path = process.env.PI_CODING_AGENT_DIR + '/auth.json';
            const release = lockSync(path, { realpath: false });
            if (${JSON.stringify(state)} === 'truncated') writeFileSync(path, '');
            const watchdog = setTimeout(() => process.exit(2), 5000);
            process.on('message', () => {
                writeFileSync(path, JSON.stringify({ openai: { type: 'api_key', key: 'synthetic-child-key' } }));
                release();
                clearTimeout(watchdog);
                process.disconnect();
            });
            process.send('locked');
        `,
                ],
                {
                    cwd: new URL("..", import.meta.url),
                    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
                    stdio: ["ignore", "ignore", "inherit", "ipc"],
                },
            )
            const exited = once(child, "exit")
            try {
                const ready = await Promise.race([
                    once(child, "message", {
                        signal: AbortSignal.timeout(5_000),
                    }),
                    exited.then(() => {
                        throw new Error("Writer exited before readiness")
                    }),
                ])
                assert.equal(ready[0], "locked")
                assert.throws(
                    () =>
                        syncAuthJson({
                            accessToken: "a",
                            refreshToken: "r",
                            expiresAt: 1,
                        }),
                    { code: "ELOCKED" },
                )
                if (state === "missing")
                    assert.equal(existsSync(authPath), false)
                else assert.equal(readFileSync(authPath, "utf-8"), "")
                assert.deepEqual(
                    readdirSync(dir).sort(),
                    state === "missing"
                        ? ["auth.json.lock"]
                        : ["auth.json", "auth.json.lock"],
                )
                child.send("commit")
                assert.deepEqual(await exited, [0, null])
                syncAuthJson({
                    accessToken: "a",
                    refreshToken: "r",
                    expiresAt: 1,
                })
                assert.deepEqual(JSON.parse(readFileSync(authPath, "utf-8")), {
                    openai: { type: "api_key", key: "synthetic-child-key" },
                    anthropic: {
                        type: "oauth",
                        access: "a",
                        refresh: "r",
                        expires: 1,
                    },
                })
                assert.deepEqual(readdirSync(dir), ["auth.json"])
            } finally {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill("SIGKILL")
                await exited
            }
        },
    )
}

for (const failure of ["read", "write", "rename"]) {
    test(`syncAuthJson: preserves original and cleans up after ${failure} failure`, (t) => {
        const authPath = join(dir, "auth.json")
        const original = '{"openai":{"key":"synthetic-original"}}'
        writeFileSync(authPath, original)
        const error = Object.assign(new Error(`injected ${failure} failure`), {
            code: "EIO",
        })
        const realWrite = fs.writeFileSync
        // Fault injection is needed to reproduce partial writes portably.
        if (failure === "write") {
            t.mock.method(fs, "writeFileSync", (path, data, options) => {
                realWrite(path, data, options)
                throw error
            })
        } else if (failure === "rename") {
            t.mock.method(fs, "renameSync", () => {
                throw error
            })
        } else {
            t.mock.method(fs, "readFileSync", () => {
                throw error
            })
        }
        syncBuiltinESMExports()
        try {
            assert.throws(
                () =>
                    syncAuthJson({
                        accessToken: "a",
                        refreshToken: "r",
                        expiresAt: 1,
                    }),
                (err) => err === error,
            )
        } finally {
            t.mock.restoreAll()
            syncBuiltinESMExports()
        }
        assert.equal(readFileSync(authPath, "utf-8"), original)
        assert.deepEqual(readdirSync(dir), ["auth.json"])
        // A subsequent write proves the error path released the lock.
        syncAuthJson({ accessToken: "a", refreshToken: "r", expiresAt: 1 })
        assert.deepEqual(readdirSync(dir), ["auth.json"])
    })
}

test("account source persistence round-trips", () => {
    assert.equal(loadPersistedAccountSource(), null)
    saveAccountSource("Claude Code-credentials")
    assert.equal(loadPersistedAccountSource(), "Claude Code-credentials")
})
