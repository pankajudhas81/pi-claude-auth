import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { fileURLToPath } from "node:url"
import lockfile from "proper-lockfile"
import {
    acquireAuthLockSync,
    AuthLockBusyError,
    setAuthJsonEntry,
} from "./auth-json.ts"

const ENTRY = { type: "oauth", access: "a", refresh: "r", expires: 1 }
const OPENAI = { type: "api_key", key: "sk-test" }

let dir = ""
let authPath = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-json-"))
    authPath = join(dir, "auth.json")
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

function readAuth(): Record<string, unknown> {
    return JSON.parse(readFileSync(authPath, "utf-8"))
}

test("setAuthJsonEntry: creates a missing auth.json and its directory", () => {
    authPath = join(dir, "nested", "agent", "auth.json")
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "written")
    assert.deepEqual(readAuth(), { anthropic: ENTRY })
    if (process.platform !== "win32") {
        assert.equal(statSync(authPath).mode & 0o777, 0o600)
    }
})

test("setAuthJsonEntry: keeps every other provider's entry", () => {
    writeFileSync(
        authPath,
        JSON.stringify({ openai: OPENAI, anthropic: { type: "oauth" } }),
    )
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "written")
    assert.deepEqual(readAuth(), { openai: OPENAI, anthropic: ENTRY })
})

for (const raw of [
    '{"openai": {"type": "api_key", "key": "sk-test"',
    "",
    " \n\t",
    "\uFEFF",
    "[]",
    "null",
    '"text"',
]) {
    test(`setAuthJsonEntry: leaves unreadable content ${JSON.stringify(raw)} untouched`, () => {
        writeFileSync(authPath, raw)
        assert.equal(
            setAuthJsonEntry(authPath, "anthropic", ENTRY),
            "unreadable",
        )
        assert.equal(readFileSync(authPath, "utf-8"), raw)
        // No lock directory or temp file is left behind.
        assert.deepEqual(readdirSync(dir), ["auth.json"])
    })
}

test("setAuthJsonEntry: merges into a BOM-prefixed file like pi does", () => {
    writeFileSync(authPath, `\uFEFF${JSON.stringify({ openai: OPENAI })}`)
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "written")
    assert.deepEqual(readAuth(), { openai: OPENAI, anthropic: ENTRY })
})

test("setAuthJsonEntry: does not rewrite an entry that already matches", () => {
    const content = JSON.stringify({ openai: OPENAI, anthropic: ENTRY })
    writeFileSync(authPath, content)
    const before = statSync(authPath)
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "unchanged")
    const after = statSync(authPath)
    assert.equal(after.ino, before.ino)
    assert.equal(readFileSync(authPath, "utf-8"), content)
})

test("setAuthJsonEntry: replaces the target of a symlinked auth.json", (t) => {
    if (process.platform === "win32") return t.skip("symlinks need privileges")
    const real = join(dir, "dotfiles-auth.json")
    writeFileSync(real, JSON.stringify({ openai: OPENAI }))
    symlinkSync(real, authPath)
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "written")
    assert.ok(lstatSync(authPath).isSymbolicLink())
    assert.deepEqual(JSON.parse(readFileSync(real, "utf-8")), {
        openai: OPENAI,
        anthropic: ENTRY,
    })
})

test("setAuthJsonEntry: waits out pi's lock instead of writing under it", () => {
    writeFileSync(authPath, JSON.stringify({ openai: OPENAI }))
    // Hold the lock exactly the way pi does.
    const release = lockfile.lockSync(authPath, { realpath: false })
    try {
        assert.throws(
            () => setAuthJsonEntry(authPath, "anthropic", ENTRY),
            AuthLockBusyError,
        )
        assert.deepEqual(readAuth(), { openai: OPENAI })
    } finally {
        release()
    }
    assert.equal(setAuthJsonEntry(authPath, "anthropic", ENTRY), "written")
    assert.deepEqual(readAuth(), { openai: OPENAI, anthropic: ENTRY })
})

test("acquireAuthLockSync: excludes pi's lock and releases cleanly", () => {
    const release = acquireAuthLockSync(authPath)
    assert.throws(
        () => lockfile.lockSync(authPath, { realpath: false }),
        (err: NodeJS.ErrnoException) => err.code === "ELOCKED",
    )
    release()
    release() // idempotent
    const piRelease = lockfile.lockSync(authPath, { realpath: false })
    piRelease()
})

test("acquireAuthLockSync: respects a lock pi may still hold", () => {
    // pi's async lock refreshes its mtime every 15s, so a 20s-old lock can
    // still belong to a live pi process.
    mkdirSync(`${authPath}.lock`)
    const twentySecondsAgo = new Date(Date.now() - 20_000)
    utimesSync(`${authPath}.lock`, twentySecondsAgo, twentySecondsAgo)
    assert.throws(() => acquireAuthLockSync(authPath), AuthLockBusyError)
})

test("acquireAuthLockSync: reclaims a lock left by a dead process", () => {
    mkdirSync(`${authPath}.lock`)
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(`${authPath}.lock`, longAgo, longAgo)
    const release = acquireAuthLockSync(authPath)
    assert.ok(statSync(`${authPath}.lock`).mtimeMs > longAgo.getTime())
    release()
    assert.deepEqual(readdirSync(dir), [])
})

// Separate processes hammer one auth.json: several run this module for their
// own provider while one plays pi, writing non-atomically under
// proper-lockfile. Without the shared lock, read-modify-write cycles
// interleave and drop entries; with it, every provider survives.
test("setAuthJsonEntry: concurrent writers in separate processes lose nothing", async () => {
    const moduleUrl = new URL("./auth-json.ts", import.meta.url).href
    const iterations = 40
    const ourWriter = (provider: string) => `
        import { setAuthJsonEntry } from ${JSON.stringify(moduleUrl)}
        for (let i = 0; i < ${iterations}; i++) {
            for (;;) {
                try {
                    setAuthJsonEntry(process.env.AUTH_PATH, ${JSON.stringify(provider)}, { type: "oauth", access: String(i) })
                    break
                } catch (err) {
                    if (err.code !== "ELOCKED") throw err
                }
            }
        }
    `
    const piWriter = `
        import { readFileSync, writeFileSync } from "node:fs"
        import lockfile from "proper-lockfile"
        const path = process.env.AUTH_PATH
        for (let i = 0; i < ${iterations}; i++) {
            let release
            for (;;) {
                try { release = lockfile.lockSync(path, { realpath: false }); break }
                catch (err) { if (err.code !== "ELOCKED") throw err }
            }
            const current = JSON.parse(readFileSync(path, "utf-8") || "{}")
            current.pi = { type: "api_key", key: String(i) }
            writeFileSync(path, JSON.stringify(current, null, 2))
            release()
        }
    `
    writeFileSync(authPath, JSON.stringify({ openai: OPENAI }))
    const scripts = [
        ourWriter("anthropic"),
        ourWriter("second"),
        ourWriter("third"),
        piWriter,
    ]
    const children = scripts.map((source) =>
        spawn(process.execPath, ["--input-type=module", "-e", source], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, AUTH_PATH: authPath },
            stdio: ["ignore", "ignore", "inherit"],
        }),
    )
    const codes = await Promise.all(
        children.map(async (child) => (await once(child, "exit"))[0]),
    )
    assert.deepEqual(codes, [0, 0, 0, 0])
    const final = readAuth()
    assert.deepEqual(Object.keys(final).sort(), [
        "anthropic",
        "openai",
        "pi",
        "second",
        "third",
    ])
    assert.deepEqual(final.openai, OPENAI)
    assert.deepEqual(readdirSync(dir), ["auth.json"])
})
