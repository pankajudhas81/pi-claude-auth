import { execFileSync, execSync } from "node:child_process"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { lockSync } from "proper-lockfile"
import {
    readAllClaudeAccounts,
    refreshAccount,
    writeBackCredentials,
    type ClaudeAccount,
    type ClaudeCredentials,
} from "./keychain.ts"
import { log } from "./logger.ts"
import { getAuthJsonPath, getPiAgentDir } from "./paths.ts"

export type { ClaudeCredentials } from "./keychain.ts"
export type { ClaudeAccount } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

const accountCacheMap = new Map<
    string,
    { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
    allAccounts = accounts
}

export function getAccounts(): ClaudeAccount[] {
    return allAccounts
}

export function setActiveAccountSource(source: string): void {
    const previous = activeAccountSource
    activeAccountSource = source
    accountCacheMap.delete(source)
    if (previous && previous !== source) {
        log("account_switch", { newSource: source, previousSource: previous })
    }
}

export function refreshAccountsList(): ClaudeAccount[] {
    allAccounts = readAllClaudeAccounts()
    return allAccounts
}

function getActiveAccount(): ClaudeAccount | null {
    if (allAccounts.length === 0) return null
    if (activeAccountSource) {
        const found = allAccounts.find((a) => a.source === activeAccountSource)
        if (found) return found
    }
    return allAccounts[0]
}

function getAccountStateFile(): string {
    return join(getPiAgentDir(), "claude-account-source.txt")
}

export function loadPersistedAccountSource(): string | null {
    try {
        const path = getAccountStateFile()
        if (existsSync(path)) {
            return readFileSync(path, "utf-8").trim() || null
        }
    } catch {
        // ignore
    }
    return null
}

export function saveAccountSource(source: string): void {
    try {
        const path = getAccountStateFile()
        const dir = dirname(path)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(path, source, "utf-8")
    } catch {
        // Non-fatal
    }
}

// pi serializes every auth.json write behind a proper-lockfile lock on the
// same path. The sync has to take the same lock, or its read-modify-write can
// interleave with a pi write (a login completed by another pi process) and
// silently drop a provider credential pi just stored.
const AUTH_LOCK_ATTEMPTS = 10
const AUTH_LOCK_RETRY_SPIN_MS = 20

function acquireAuthLockSync(authPath: string): () => void {
    for (let attempt = 1; attempt <= AUTH_LOCK_ATTEMPTS; attempt++) {
        try {
            return lockSync(authPath, { realpath: false })
        } catch (err) {
            const code = (err as NodeJS.ErrnoException | null)?.code
            if (code !== "ELOCKED" || attempt === AUTH_LOCK_ATTEMPTS) throw err
            const deadline = Date.now() + AUTH_LOCK_RETRY_SPIN_MS
            while (Date.now() < deadline) {
                /* brief spin between attempts, mirroring pi's retry loop */
            }
        }
    }
    throw new Error(`Could not acquire lock on ${authPath}`)
}

function parseAuthJson(raw: string): Record<string, unknown> | null {
    // Strip a UTF-8 BOM the same way pi does, so a BOM-prefixed but otherwise
    // valid auth.json is merged instead of treated as corrupt.
    const trimmed = raw.replace(/^\uFEFF/, "").trim()
    if (!trimmed) return null
    try {
        const parsed: unknown = JSON.parse(trimmed)
        if (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
        ) {
            return parsed as Record<string, unknown>
        }
    } catch {
        // fall through to the malformed case
    }
    return null
}

// Keep at most this many `auth.json.corrupt-*` backups so a persistently
// corrupt file cannot accumulate an unbounded pile of credential-bearing
// copies.
const CORRUPT_BACKUP_LIMIT = 10

function writeCorruptBackup(
    dir: string,
    authPath: string,
    raw: string,
): string {
    const prefix = `${basename(authPath)}.corrupt-`
    // Reuse an existing backup with identical content instead of writing a
    // new one on every sync while the file stays corrupt.
    const existing = readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .sort()
    for (const name of existing) {
        try {
            if (readFileSync(join(dir, name), "utf-8") === raw) {
                return join(dir, name)
            }
        } catch {
            // unreadable backup, ignore it
        }
    }
    while (existing.length >= CORRUPT_BACKUP_LIMIT) {
        rmSync(join(dir, existing.shift() as string), { force: true })
    }
    const backup = join(
        dir,
        `${prefix}${new Date().toISOString().replace(/[:.]/g, "-")}`,
    )
    writeFileSync(backup, raw, { encoding: "utf-8", mode: 0o600 })
    return backup
}

function syncToPath(authPath: string, creds: ClaudeCredentials): boolean {
    const dir = dirname(authPath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const release = acquireAuthLockSync(authPath)
    try {
        // Only absence observed under the lock permits initialization. Never
        // create a placeholder before locking: it could truncate a pi write.
        let raw = "{}"
        try {
            raw = readFileSync(authPath, "utf-8")
        } catch (err) {
            if (
                typeof err !== "object" ||
                err === null ||
                !("code" in err) ||
                err.code !== "ENOENT"
            ) {
                throw err
            }
        }
        const auth = parseAuthJson(raw)
        if (auth === null) {
            // Never replace a malformed auth.json wholesale: the old code
            // reset it to `{}` + `anthropic`, wiping every other provider's
            // credentials. Keep the corrupt bytes in a sibling backup and
            // skip this sync instead.
            const backup = writeCorruptBackup(dir, authPath, raw)
            log("sync_auth_json_corrupt", { path: authPath, backup })
            return false
        }
        // pi persists OAuth credentials as `{ type: "oauth", access, refresh,
        // expires }` keyed by provider id. Seeding the `anthropic` entry lets
        // pi use the Claude Code credentials with no separate /login.
        auth.anthropic = {
            type: "oauth",
            access: creds.accessToken,
            refresh: creds.refreshToken,
            expires: creds.expiresAt,
        }
        // A unique private sibling directory keeps the temp file on the same
        // filesystem and prevents collisions. Clean up even a partial write.
        const tmpDir = mkdtempSync(join(dir, ".auth.json.tmp-"))
        const tmpPath = join(tmpDir, "auth.json")
        try {
            writeFileSync(tmpPath, JSON.stringify(auth, null, 2), {
                encoding: "utf-8",
                mode: 0o600,
                flag: "wx",
            })
            renameSync(tmpPath, authPath)
        } finally {
            // Best-effort cleanup that must not mask the original error.
            try {
                rmSync(tmpDir, { recursive: true, force: true })
            } catch {
                // ignore
            }
        }
        if (process.platform !== "win32") {
            chmodSync(authPath, 0o600)
        }
        return true
    } finally {
        try {
            release()
        } catch {
            // The lock can already be gone (stale takeover by another
            // process); the write above already succeeded or failed.
        }
    }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
    const authPath = getAuthJsonPath()
    try {
        const written = syncToPath(authPath, creds)
        log("sync_auth_json", { path: authPath, success: written })
    } catch (err) {
        log("sync_auth_json", {
            path: authPath,
            success: false,
            error: err instanceof Error ? err.message : String(err),
        })
        throw err
    }
}

export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Parse a raw OAuth token response into ClaudeCredentials.
 * Returns null if the response is missing a valid access_token.
 * Defaults expires_in to 36000s (10h) to match observed Claude token lifetime.
 */
export function parseOAuthResponse(
    raw: string,
    currentRefreshToken: string,
    now: number = Date.now(),
): ClaudeCredentials | null {
    let data: {
        access_token?: string
        refresh_token?: string
        expires_in?: number
        error?: string
    }
    try {
        data = JSON.parse(raw)
    } catch {
        return null
    }

    if (!data.access_token) return null

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? currentRefreshToken,
        expiresAt: now + (data.expires_in ?? 36_000) * 1000,
    }
}

export function refreshViaOAuth(
    refreshToken: string,
): ClaudeCredentials | null {
    // Use a Node subprocess to perform the HTTP request synchronously.
    // The refresh token is passed via stdin to avoid exposure in process args.
    const script = `
    process.stdin.resume();
    let input = '';
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: '${OAUTH_CLIENT_ID}',
        refresh_token: input.trim()
      });
      fetch('${OAUTH_TOKEN_URL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(d => { process.stdout.write(JSON.stringify(d)); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: String(e) })); process.exit(1); });
    });
  `

    try {
        log("refresh_started", { source: "oauth" })
        const result = execFileSync(process.execPath, ["-e", script], {
            input: refreshToken,
            timeout: 15_000,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
        })

        const creds = parseOAuthResponse(result, refreshToken)
        if (!creds) {
            log("refresh_failed", {
                source: "oauth",
                error: "no access_token in response",
            })
            return null
        }

        log("refresh_success", { source: "oauth" })
        return creds
    } catch (err) {
        log("refresh_failed", {
            source: "oauth",
            error: err instanceof Error ? err.message : String(err),
        })
        return null
    }
}

function refreshViaCli(): void {
    const maxAttempts = 2
    for (let i = 0; i < maxAttempts; i++) {
        log("refresh_started", { source: "cli", attempt: i + 1 })
        try {
            execSync("claude -p . --model haiku", {
                timeout: 60_000,
                encoding: "utf-8",
                env: { ...process.env, TERM: "dumb" },
                stdio: "ignore",
                cwd: tmpdir(),
            })
            log("refresh_success", { source: "cli" })
            return
        } catch (err) {
            log("refresh_failed", {
                source: "cli",
                attempt: i + 1,
                error: err instanceof Error ? err.message : String(err),
            })
            // Non-fatal: retry once, then give up
        }
    }
}

export function refreshIfNeeded(
    account?: ClaudeAccount,
): ClaudeCredentials | null {
    const target = account ?? getActiveAccount()
    if (!target) return null

    // Pick up external updates to .credentials.json (e.g. the Claude CLI
    // refreshing in another process). Bounded by getCachedCredentials's 30s
    // TTL. macOS keychain sources stay on the in-memory path; their state is
    // mutated only by our own writeBackCredentials.
    if (target.source === "file") {
        const onDisk = refreshAccount(target.source)
        if (onDisk) target.credentials = onDisk
    }

    const creds = target.credentials
    if (creds.expiresAt > Date.now() + 60_000) return creds

    log("refresh_needed", {
        source: target.source,
        expiresAt: creds.expiresAt,
        expiresIn: creds.expiresAt - Date.now(),
    })

    // Try direct OAuth refresh first (zero LLM tokens consumed)
    if (creds.refreshToken) {
        const oauthCreds = refreshViaOAuth(creds.refreshToken)
        if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
            target.credentials = oauthCreds
            writeBackCredentials(target.source, oauthCreds)
            return oauthCreds
        }
    }

    // Fall back to CLI-based refresh (consumes Haiku tokens)
    log("refresh_fallback_cli", { source: target.source })
    refreshViaCli()
    const refreshed = refreshAccount(target.source)
    if (refreshed && refreshed.expiresAt > Date.now() + 60_000) {
        target.credentials = refreshed
        return refreshed
    }

    log("refresh_exhausted", {
        source: target.source,
        hadCredentials: !!refreshed,
        expiresAt: refreshed?.expiresAt,
    })
    return null
}

/**
 * Force a refresh of the active account's credentials and write the rotated
 * tokens back to storage. Used by pi's `oauth.refreshToken` hook, which is
 * invoked when the token stored in auth.json is at/near expiry.
 *
 * Re-reads the source first (the Claude CLI may have already rotated the
 * token), then falls back to a direct OAuth refresh.
 */
export function forceRefreshActiveCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    accountCacheMap.delete(account.source)

    // The on-disk/keychain source may already hold a fresher token.
    const onDisk = refreshAccount(account.source)
    if (onDisk) account.credentials = onDisk
    if (account.credentials.expiresAt > Date.now() + 60_000) {
        accountCacheMap.set(account.source, {
            creds: account.credentials,
            cachedAt: Date.now(),
        })
        return account.credentials
    }

    const fresh = refreshIfNeeded(account)
    if (fresh) {
        accountCacheMap.set(account.source, {
            creds: fresh,
            cachedAt: Date.now(),
        })
    }
    return fresh
}

/**
 * Returns the active account's credentials for auth.json sync purposes.
 * Unlike getCachedCredentials(), this does NOT trigger a refresh.
 * Returns null if no account or credentials are expired.
 */
export function getCredentialsForSync(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const creds = account.credentials
    if (creds.expiresAt > Date.now() + 60_000) {
        return creds
    }

    // Near expiry -- don't refresh here, let the per-request path handle it.
    return null
}

export function getCachedCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const now = Date.now()
    const cached = accountCacheMap.get(account.source)
    if (
        cached &&
        now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
        cached.creds.expiresAt > now + 60_000
    ) {
        log("cache_hit", {
            source: account.source,
            ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
        })
        return cached.creds
    }

    log("cache_miss", {
        source: account.source,
        reason: cached ? "stale or expiring" : "empty",
    })

    const fresh = refreshIfNeeded(account)
    if (!fresh) {
        log("credentials_unavailable", { source: account.source })
        accountCacheMap.delete(account.source)
        return null
    }

    accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
    return fresh
}
