import { spawn } from "node:child_process"
import { once } from "node:events"
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
    let auth: Record<string, unknown> = {}
    if (existsSync(authPath)) {
        const raw = readFileSync(authPath, "utf-8").trim()
        if (raw) {
            try {
                auth = JSON.parse(raw)
            } catch {
                // Malformed file, start fresh
            }
        }
    }
    // pi persists OAuth credentials as `{ type: "oauth", access, refresh,
    // expires }` keyed by provider id. Seeding the `anthropic` entry lets pi
    // use the Claude Code credentials with no separate /login.
    auth.anthropic = {
        type: "oauth",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
    const dir = dirname(authPath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    writeFileSync(authPath, JSON.stringify(auth, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
    })
    if (process.platform !== "win32") {
        chmodSync(authPath, 0o600)
    }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
    const authPath = getAuthJsonPath()
    try {
        syncToPath(authPath, creds)
        log("sync_auth_json", { path: authPath, success: true })
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

/** Upper bound for one OAuth token request. */
const OAUTH_TIMEOUT_MS = 5_000

/** Upper bound for one delegated `claude -p` refresh run. */
const CLI_TIMEOUT_MS = 60_000

/**
 * How long `forceRefreshActiveCredentials` lets its caller wait. pi gives its
 * whole model-catalog refresh 15s, and calls `refreshToken` while holding its
 * auth.json lock, so a refresh still running after this keeps going in the
 * background and the caller gets an answer now.
 */
export const REFRESH_WAIT_MS = 8_000

/**
 * After a refresh attempt fails, the same refresh token is not tried again
 * for this long (a `claude -p` run costs real tokens). A refresh token the
 * OAuth endpoint rejected is never retried; a different one, e.g. after the
 * user re-runs `claude`, starts fresh immediately.
 */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000

/** Refreshes in flight, keyed by the refresh token they spend. */
const refreshesInFlight = new Map<string, Promise<ClaudeCredentials | null>>()
/** Earliest time a failed refresh token may be tried again. */
const retryNotBefore = new Map<string, number>()

type OAuthRefreshResult = ClaudeCredentials | "rejected" | "failed"

/**
 * Exchange a refresh token at Anthropic's OAuth endpoint, in process and
 * bounded by OAUTH_TIMEOUT_MS. "rejected" means the server refused the token
 * (400/401), so retrying it cannot help; "failed" covers everything
 * transient (network errors, timeouts, 403 from bot protection, 5xx).
 */
export async function refreshViaOAuth(
    refreshToken: string,
): Promise<OAuthRefreshResult> {
    log("refresh_started", { source: "oauth" })
    try {
        const response = await fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "refresh_token",
                client_id: OAUTH_CLIENT_ID,
                refresh_token: refreshToken,
            }).toString(),
            signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
        })
        const body = await response.text()
        if (!response.ok) {
            const rejected = response.status === 400 || response.status === 401
            log("refresh_failed", { source: "oauth", status: response.status })
            return rejected ? "rejected" : "failed"
        }
        const creds = parseOAuthResponse(body, refreshToken)
        if (!creds) {
            log("refresh_failed", {
                source: "oauth",
                error: "no access_token in response",
            })
            return "failed"
        }
        log("refresh_success", { source: "oauth" })
        return creds
    } catch (err) {
        log("refresh_failed", {
            source: "oauth",
            error: err instanceof Error ? err.message : String(err),
        })
        return "failed"
    }
}

/**
 * Let the Claude CLI refresh its own stored credentials by running one tiny
 * headless prompt. Asynchronous and bounded by CLI_TIMEOUT_MS; resolves to
 * whether the CLI exited successfully.
 */
async function refreshViaCli(): Promise<boolean> {
    log("refresh_started", { source: "cli" })
    // A shell on Windows resolves npm's `claude.cmd` shim; the command line is
    // constant.
    const child = spawn("claude", ["-p", ".", "--model", "haiku"], {
        cwd: tmpdir(),
        env: { ...process.env, TERM: "dumb" },
        stdio: "ignore",
        shell: process.platform === "win32",
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
    })
    // Never keep pi alive just for a background refresh.
    child.unref()
    try {
        const [code, signal] = await once(child, "exit")
        if (code === 0) log("refresh_success", { source: "cli" })
        else log("refresh_failed", { source: "cli", code, signal })
        return code === 0
    } catch (err) {
        log("refresh_failed", {
            source: "cli",
            error: err instanceof Error ? err.message : String(err),
        })
        return false
    }
}

function isFresh(creds: ClaudeCredentials): boolean {
    return creds.expiresAt > Date.now() + 60_000
}

/** One refresh of `target`, spending `refreshToken`. Never rejects. */
async function runRefresh(
    target: ClaudeAccount,
    refreshToken: string,
): Promise<ClaudeCredentials | null> {
    // Direct OAuth refresh first: zero LLM tokens consumed.
    const oauth = await refreshViaOAuth(refreshToken)
    if (typeof oauth === "object" && isFresh(oauth)) {
        target.credentials = oauth
        writeBackCredentials(target.source, oauth)
        return oauth
    }
    if (oauth === "rejected") {
        // The token is dead; the CLI would only spend tokens failing on it.
        retryNotBefore.set(refreshToken, Number.POSITIVE_INFINITY)
        log("refresh_exhausted", { source: target.source, reason: "rejected" })
        return null
    }

    // Fall back to the Claude CLI (consumes Haiku tokens).
    log("refresh_fallback_cli", { source: target.source })
    await refreshViaCli()
    const refreshed = refreshAccount(target.source)
    if (refreshed && isFresh(refreshed)) {
        target.credentials = refreshed
        return refreshed
    }

    retryNotBefore.set(refreshToken, Date.now() + RETRY_AFTER_FAILURE_MS)
    log("refresh_exhausted", {
        source: target.source,
        hadCredentials: !!refreshed,
        expiresAt: refreshed?.expiresAt,
    })
    return null
}

/**
 * Return fresh credentials for `account` (default: the active account),
 * refreshing them if needed. Never blocks the event loop.
 *
 * The stored credentials are re-read first: the Claude CLI may already have
 * rotated them. Concurrent callers share one refresh per refresh token, and a
 * refresh token that just failed is not retried (see RETRY_AFTER_FAILURE_MS),
 * so an expired login costs one failed attempt, not one per pi request.
 */
export async function refreshIfNeeded(
    account?: ClaudeAccount,
): Promise<ClaudeCredentials | null> {
    const target = account ?? getActiveAccount()
    if (!target) return null

    const onDisk = refreshAccount(target.source)
    if (onDisk) target.credentials = onDisk
    const creds = target.credentials
    if (isFresh(creds)) return creds

    const refreshToken = creds.refreshToken
    if (!refreshToken) return null
    const inFlight = refreshesInFlight.get(refreshToken)
    if (inFlight) return inFlight
    if ((retryNotBefore.get(refreshToken) ?? 0) > Date.now()) {
        log("refresh_skipped", {
            source: target.source,
            reason: "recent failure",
        })
        return null
    }

    log("refresh_needed", {
        source: target.source,
        expiresAt: creds.expiresAt,
        expiresIn: creds.expiresAt - Date.now(),
    })
    const pending = runRefresh(target, refreshToken).finally(() => {
        refreshesInFlight.delete(refreshToken)
    })
    refreshesInFlight.set(refreshToken, pending)
    return pending
}

/**
 * Refresh the active account's credentials, waiting at most REFRESH_WAIT_MS
 * or until `signal` aborts. Used by pi's `oauth.refreshToken` hook, which pi
 * invokes when the token in auth.json is at or near expiry. A refresh that
 * outlasts the wait keeps running; its result is picked up on the next call.
 */
export async function forceRefreshActiveCredentials(
    signal?: AbortSignal,
): Promise<ClaudeCredentials | null> {
    const account = getActiveAccount()
    if (!account || signal?.aborted) return null
    accountCacheMap.delete(account.source)

    const waits = [AbortSignal.timeout(REFRESH_WAIT_MS)]
    if (signal) waits.push(signal)
    const stop = AbortSignal.any(waits)
    const fresh = await Promise.race([
        refreshIfNeeded(account),
        once(stop, "abort").then(() => null),
    ])
    if (fresh) {
        accountCacheMap.set(account.source, {
            creds: fresh,
            cachedAt: Date.now(),
        })
    } else if (stop.aborted) {
        log("refresh_wait_elapsed", { source: account.source })
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
    if (isFresh(creds)) {
        return creds
    }

    // Near expiry -- don't refresh here, let the per-request path handle it.
    return null
}

/**
 * Synchronous access to the active account's credentials, for pi's
 * synchronous `getApiKey` hook and extension startup.
 *
 * Never waits on the network or the Claude CLI: when the credentials are
 * expired it re-reads them from storage, starts a background refresh, and
 * returns null; the refreshed credentials are served once it lands.
 */
export function getCachedCredentials(): ClaudeCredentials | null {
    const account = getActiveAccount()
    if (!account) return null

    const now = Date.now()
    const cached = accountCacheMap.get(account.source)
    if (
        cached &&
        now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
        isFresh(cached.creds)
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

    const onDisk = refreshAccount(account.source)
    if (onDisk) account.credentials = onDisk
    if (isFresh(account.credentials)) {
        accountCacheMap.set(account.source, {
            creds: account.credentials,
            cachedAt: now,
        })
        return account.credentials
    }

    accountCacheMap.delete(account.source)
    log("credentials_unavailable", { source: account.source })
    void refreshIfNeeded(account)
    return null
}
