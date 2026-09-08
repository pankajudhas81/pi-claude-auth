import {
    mkdirSync,
    renameSync,
    rmdirSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

/**
 * Cross-process locking for pi's `auth.json`, compatible with the lock pi
 * itself takes.
 *
 * pi's `FileAuthStorageBackend` guards every auth.json mutation with
 * `proper-lockfile`, whose on-disk protocol is a directory named
 * `<file>.lock`: `mkdir` succeeds for exactly one holder, the directory mtime
 * marks the lock fresh, and a lock older than `stale` may be removed by a
 * competing process. Re-implementing that protocol (rather than depending on
 * `proper-lockfile`) keeps this extension dependency-free while still
 * interlocking with pi's own writes.
 *
 * Without this lock the extension's read-modify-write of auth.json races pi's:
 * pi truncates auth.json before writing it (plain `writeFileSync`), so an
 * unlocked reader can observe an empty file, and writing the result back
 * destroys every credential the extension does not itself manage (for example
 * `openai-codex`).
 */

/** Matches `proper-lockfile`'s default `stale` window. */
const STALE_MS = 10_000
const ACQUIRE_TIMEOUT_MS = 2_000
const RETRY_DELAY_MS = 20

/** Thrown when the lock could not be acquired within `ACQUIRE_TIMEOUT_MS`. */
export class AuthLockBusyError extends Error {
    constructor(path: string) {
        super(`Timed out acquiring the auth storage lock for ${path}`)
        this.name = "AuthLockBusyError"
    }
}

function errorCode(err: unknown): string | undefined {
    return typeof err === "object" && err !== null && "code" in err
        ? String((err as { code: unknown }).code)
        : undefined
}

/** Block the current thread without burning CPU (this API is synchronous). */
export function sleepSync(ms: number): void {
    const shared = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(shared, 0, 0, ms)
}

function lockPathFor(targetPath: string): string {
    return `${targetPath}.lock`
}

function isStale(lockPath: string): boolean {
    try {
        return Date.now() - statSync(lockPath).mtimeMs > STALE_MS
    } catch {
        // Vanished between mkdir failure and stat: treat as free.
        return true
    }
}

/**
 * Acquire the auth.json lock, returning a release function.
 *
 * @throws AuthLockBusyError when the lock stays held past the timeout.
 */
export function acquireAuthLockSync(targetPath: string): () => void {
    const lockPath = lockPathFor(targetPath)
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
    let released = false

    for (;;) {
        try {
            mkdirSync(lockPath)
            return () => {
                if (released) return
                released = true
                try {
                    rmdirSync(lockPath)
                } catch {
                    // Already removed (e.g. reclaimed as stale): nothing to do.
                }
            }
        } catch (err) {
            if (errorCode(err) !== "EEXIST") throw err
            if (isStale(lockPath)) {
                try {
                    rmdirSync(lockPath)
                } catch {
                    // Another process reclaimed it first; retry below.
                }
                continue
            }
            if (Date.now() >= deadline) throw new AuthLockBusyError(targetPath)
            sleepSync(RETRY_DELAY_MS)
        }
    }
}

/** Run `fn` while holding the auth.json lock. */
export function withAuthLockSync<T>(targetPath: string, fn: () => T): T {
    const release = acquireAuthLockSync(targetPath)
    try {
        return fn()
    } finally {
        release()
    }
}

/**
 * Write `contents` through a temp file + rename so readers never observe a
 * truncated auth.json — including readers that do not take the lock.
 */
export function writeFileAtomicSync(path: string, contents: string): void {
    const tmpPath = join(
        dirname(path),
        `.${process.pid}-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2)}.tmp`,
    )
    try {
        writeFileSync(tmpPath, contents, { encoding: "utf-8", mode: 0o600 })
        renameSync(tmpPath, path)
    } catch (err) {
        try {
            unlinkSync(tmpPath)
        } catch {
            // Best-effort cleanup.
        }
        throw err
    }
}
