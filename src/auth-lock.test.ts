import assert from "node:assert/strict"
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import {
    AuthLockBusyError,
    acquireAuthLockSync,
    withAuthLockSync,
    writeFileAtomicSync,
} from "./auth-lock.ts"

let dir = ""
let target = ""

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-claude-auth-lock-test-"))
    target = join(dir, "auth.json")
    writeFileSync(target, "{}", "utf-8")
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
})

test("acquireAuthLockSync: creates and removes the proper-lockfile lock dir", () => {
    const release = acquireAuthLockSync(target)
    assert.equal(existsSync(`${target}.lock`), true)
    release()
    assert.equal(existsSync(`${target}.lock`), false)
})

test("acquireAuthLockSync: release is idempotent", () => {
    const release = acquireAuthLockSync(target)
    release()
    release()
    assert.equal(existsSync(`${target}.lock`), false)
})

test("acquireAuthLockSync: throws AuthLockBusyError while another holder is fresh", () => {
    // Simulate pi holding the lock (proper-lockfile uses this exact path).
    mkdirSync(`${target}.lock`)
    assert.throws(() => acquireAuthLockSync(target), AuthLockBusyError)
    rmSync(`${target}.lock`, { recursive: true })
})

test("acquireAuthLockSync: reclaims a stale lock", () => {
    mkdirSync(`${target}.lock`)
    const longAgo = new Date(Date.now() - 60_000)
    utimesSync(`${target}.lock`, longAgo, longAgo)
    const release = acquireAuthLockSync(target)
    assert.equal(existsSync(`${target}.lock`), true)
    release()
})

test("withAuthLockSync: releases the lock when the callback throws", () => {
    assert.throws(() =>
        withAuthLockSync(target, () => {
            throw new Error("boom")
        }),
    )
    assert.equal(existsSync(`${target}.lock`), false)
})

test("writeFileAtomicSync: replaces content without leaving temp files", () => {
    writeFileAtomicSync(target, '{"a":1}')
    assert.equal(readFileSync(target, "utf-8"), '{"a":1}')
    assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith(".tmp")),
        [],
    )
})
