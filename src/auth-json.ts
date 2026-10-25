import { randomBytes } from "node:crypto"
import {
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

/**
 * Safe updates to pi's shared `auth.json`.
 *
 * auth.json holds credentials for every pi provider, and several processes
 * write it: each pi session, its subagents, and this extension in each of
 * them. Every update here therefore:
 *
 * - holds the same cross-process lock pi takes for the whole
 *   read-modify-write, so it cannot interleave with a pi write;
 * - never rewrites a file it could not parse, so a corrupt or half-written
 *   file cannot be "repaired" into one that lost other providers;
 * - replaces the file through a temp file and rename, so no reader ever sees
 *   a truncated file;
 * - keeps every other provider's entry untouched.
 *
 * Lock protocol: pi guards auth.json with `proper-lockfile` (`realpath:
 * false`), whose on-disk protocol is a directory named
 * `<resolved file path>.lock`. `mkdir` succeeds for exactly one holder, the
 * directory's mtime marks the lock as fresh, a competitor may remove a lock
 * whose mtime is older than its `stale` window, and release is `rmdir`. This
 * module speaks that protocol directly rather than importing proper-lockfile:
 * that keeps the package dependency-free, and proper-lockfile's
 * mtime-precision probe has been reported to crash pi's embedded Bun runtime
 * on the second lock in a process (fdietze/pi-claude-auth@11df3b7). The lock
 * directory stays empty so pi's `rmdir` release and stale reclaim work on it.
 */

/**
 * A lock is only reclaimed once its mtime is older than this. pi's async lock
 * uses `stale: 30_000` and refreshes the mtime every 15s while held (pi holds
 * it across an OAuth refresh), so a live pi lock is never this old. pi's own
 * synchronous lock reclaims after 10s; being slower than pi here can only
 * delay a sync, never steal a live lock.
 */
const STALE_MS = 30_000

/** Same budget as pi's synchronous lock: 10 attempts, 20ms apart. */
const MAX_ATTEMPTS = 10
const RETRY_DELAY_MS = 20

/** Thrown when another process keeps holding the lock. */
export class AuthLockBusyError extends Error {
    readonly code = "ELOCKED"

    constructor(path: string) {
        super(`auth.json lock is held by another process: ${path}.lock`)
        this.name = "AuthLockBusyError"
    }
}

function errorCode(err: unknown): string | undefined {
    if (typeof err !== "object" || err === null || !("code" in err)) {
        return undefined
    }
    return String(err.code)
}

/** Block the current thread without spinning; callers are synchronous. */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function removeLockDir(lockPath: string): void {
    try {
        rmdirSync(lockPath)
    } catch (err) {
        if (errorCode(err) !== "ENOENT") throw err
    }
}

function isStale(lockPath: string): boolean {
    try {
        return statSync(lockPath).mtimeMs < Date.now() - STALE_MS
    } catch (err) {
        // Released between our mkdir and stat: retry immediately.
        if (errorCode(err) === "ENOENT") return true
        throw err
    }
}

/**
 * Acquire the lock guarding `targetPath`, returning an idempotent release
 * function. `targetPath` must be the absolute path pi locks (see
 * `getAuthJsonPath`).
 *
 * @throws AuthLockBusyError when the lock stays held for the whole budget.
 */
export function acquireAuthLockSync(targetPath: string): () => void {
    const lockPath = `${targetPath}.lock`
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            mkdirSync(lockPath)
            let released = false
            return () => {
                if (released) return
                released = true
                removeLockDir(lockPath)
            }
        } catch (err) {
            if (errorCode(err) !== "EEXIST") throw err
        }
        if (isStale(lockPath)) {
            // Same reclaim proper-lockfile performs: remove, then race to
            // recreate on the next attempt.
            removeLockDir(lockPath)
            continue
        }
        if (attempt < MAX_ATTEMPTS) sleepSync(RETRY_DELAY_MS)
    }
    throw new AuthLockBusyError(targetPath)
}

/** Result of `setAuthJsonEntry`. Only `"written"` changed the file. */
export type AuthJsonUpdate = "written" | "unchanged" | "unreadable"

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse auth.json content the way pi does (a UTF-8 BOM is ignored), or return
 * null when it is not a JSON object. Empty and whitespace-only content is
 * null as well: under this lock it can only come from a writer that does not
 * take the lock and is mid-write, and replacing the file then would orphan
 * that writer's data.
 */
export function parseAuthJson(raw: string): Record<string, unknown> | null {
    const text = raw.replace(/^\uFEFF/, "")
    if (!text.trim()) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        return null
    }
    return isPlainObject(parsed) ? parsed : null
}

function readIfExists(path: string): string | null {
    try {
        return readFileSync(path, "utf-8")
    } catch (err) {
        if (errorCode(err) === "ENOENT") return null
        throw err
    }
}

/**
 * Replace `path` with `contents` through a uniquely named sibling temp file
 * and a rename, so readers see either the old or the new file, never a
 * partial one. A symlinked auth.json (e.g. from dotfiles) keeps its link: the
 * file it points to is replaced instead.
 */
function writeFileAtomicSync(path: string, contents: string): void {
    let target = path
    try {
        target = realpathSync(path)
    } catch (err) {
        if (errorCode(err) !== "ENOENT") throw err
    }
    const tmpPath = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    try {
        writeFileSync(tmpPath, contents, {
            encoding: "utf-8",
            mode: 0o600,
            flag: "wx",
        })
        renameSync(tmpPath, target)
    } catch (err) {
        rmSync(tmpPath, { force: true })
        throw err
    }
}

function sameEntry(existing: unknown, entry: Record<string, unknown>): boolean {
    if (!isPlainObject(existing)) return false
    return Object.entries(entry).every(
        ([key, value]) => existing[key] === value,
    )
}

/**
 * Set one provider's entry in auth.json, leaving every other entry as it is.
 *
 * Holds pi's lock for the whole read-modify-write. A missing file is created;
 * a file that is not a JSON object is left byte-for-byte untouched and
 * reported as `"unreadable"`. An entry that already matches is not rewritten.
 *
 * @throws AuthLockBusyError when another process keeps holding the lock.
 */
export function setAuthJsonEntry(
    authPath: string,
    provider: string,
    entry: Record<string, unknown>,
): AuthJsonUpdate {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
    const release = acquireAuthLockSync(authPath)
    try {
        const raw = readIfExists(authPath)
        const auth = raw === null ? {} : parseAuthJson(raw)
        if (!auth) return "unreadable"
        if (sameEntry(auth[provider], entry)) return "unchanged"
        auth[provider] = entry
        writeFileAtomicSync(authPath, JSON.stringify(auth, null, 2))
        return "written"
    } finally {
        release()
    }
}
