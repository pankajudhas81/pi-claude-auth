import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { syncAuthJson } from "./credentials.ts"

const creds = (n: string) => ({
    accessToken: `access-${n}`,
    refreshToken: `refresh-${n}`,
    expiresAt: 4_102_444_800_000,
})

const OTHERS = {
    antigravity: { type: "oauth", access: "ag", refresh: "agr", expires: 1 },
    "openai-codex": { type: "oauth", access: "cx", refresh: "cxr", expires: 2 },
    "llama.cpp": { type: "api_key", key: "k" },
}

describe("syncAuthJson", () => {
    let dir: string
    let authPath: string
    const prevEnv = process.env.PI_CODING_AGENT_DIR

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-test-"))
        authPath = join(dir, "auth.json")
        process.env.PI_CODING_AGENT_DIR = dir
    })
    afterEach(() => {
        if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
        else process.env.PI_CODING_AGENT_DIR = prevEnv
        rmSync(dir, { recursive: true, force: true })
    })

    const read = () => JSON.parse(readFileSync(authPath, "utf-8"))

    test("preserves other providers and updates anthropic", () => {
        writeFileSync(authPath, JSON.stringify({ ...OTHERS }))
        syncAuthJson(creds("1"))
        const auth = read()
        assert.deepEqual(Object.keys(auth).sort(), [
            "anthropic",
            "antigravity",
            "llama.cpp",
            "openai-codex",
        ])
        assert.equal(auth.anthropic.access, "access-1")
        assert.deepEqual(auth.antigravity, OTHERS.antigravity)
    })

    test("creates the file with mode 0600 and leaves no tmp/lock files", () => {
        syncAuthJson(creds("1"))
        assert.equal(statSync(authPath).mode & 0o777, 0o600)
        assert.deepEqual(readdirSync(dir), ["auth.json"])
    })

    test("does not rewrite the file when nothing changed", () => {
        syncAuthJson(creds("1"))
        const before = statSync(authPath)
        syncAuthJson(creds("1"))
        const after = statSync(authPath)
        assert.equal(after.ino, before.ino)
        assert.equal(after.mtimeMs, before.mtimeMs)
    })

    test("never starts fresh on an unparseable auth.json", () => {
        writeFileSync(authPath, '{"antigravity": {"type": "oauth", "acc')
        const original = readFileSync(authPath, "utf-8")
        assert.doesNotThrow(() => syncAuthJson(creds("1")))
        assert.equal(readFileSync(authPath, "utf-8"), original)
    })

    test("never starts fresh on an existing empty auth.json", () => {
        writeFileSync(authPath, "")
        assert.doesNotThrow(() => syncAuthJson(creds("1")))
        assert.equal(readFileSync(authPath, "utf-8"), "")
    })

    test("skips (without hanging) while another process holds the auth lock", () => {
        writeFileSync(authPath, JSON.stringify({ ...OTHERS }))
        mkdirSync(`${authPath}.lock`) // fresh lock => live holder, e.g. pi mid-refresh
        const t0 = Date.now()
        syncAuthJson(creds("1"))
        assert.ok(Date.now() - t0 < 10_000)
        assert.equal(read().anthropic, undefined)
        assert.ok(existsSync(`${authPath}.lock`), "must not remove a live lock")
    })

    test("reclaims a stale lock", () => {
        writeFileSync(authPath, JSON.stringify({ ...OTHERS }))
        const lock = `${authPath}.lock`
        mkdirSync(lock)
        const old = new Date(Date.now() - 120_000)
        utimesSync(lock, old, old)
        syncAuthJson(creds("1"))
        assert.equal(read().anthropic.access, "access-1")
        assert.deepEqual(readdirSync(dir), ["auth.json"])
    })

    test("concurrent syncs from many processes never expose or cause data loss", async () => {
        writeFileSync(authPath, JSON.stringify({ ...OTHERS }))
        const credsModule = fileURLToPath(
            new URL("./credentials.ts", import.meta.url),
        )
        const child = `
            import { syncAuthJson } from ${JSON.stringify(credsModule)}
            for (let i = 0; i < 400; i++) {
                syncAuthJson({ accessToken: "a-" + process.pid + "-" + i, refreshToken: "r", expiresAt: 4102444800000 })
            }`
        const procs = Array.from(
            { length: 8 },
            () =>
                new Promise<number | null>((resolve) => {
                    const p = spawn(
                        process.execPath,
                        [
                            "--experimental-strip-types",
                            "--input-type=module",
                            "-e",
                            child,
                        ],
                        { env: process.env, stdio: "ignore" },
                    )
                    p.on("close", resolve)
                }),
        )
        const stop = new AbortController()
        let bad = 0
        const monitor = (async () => {
            while (!stop.signal.aborted) {
                try {
                    const raw = readFileSync(authPath, "utf-8")
                    const keys = Object.keys(JSON.parse(raw))
                    if (
                        !["antigravity", "openai-codex", "llama.cpp"].every(
                            (k) => keys.includes(k),
                        )
                    )
                        bad++
                } catch {
                    bad++ // empty or torn file observed
                }
                await new Promise((r) => setImmediate(r))
            }
        })()
        const codes = await Promise.all(procs)
        stop.abort()
        await monitor
        assert.deepEqual(codes, Array(8).fill(0))
        assert.equal(
            bad,
            0,
            "auth.json was observed empty/torn/missing providers",
        )
        assert.deepEqual(Object.keys(read()).sort(), [
            "anthropic",
            "antigravity",
            "llama.cpp",
            "openai-codex",
        ])
        assert.deepEqual(readdirSync(dir), ["auth.json"])
    })
})
