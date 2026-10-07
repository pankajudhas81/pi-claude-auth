import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs"
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
const OAUTH_REFRESH_TIMEOUT_MS = 5_000
const oauthRefreshes = new Map<string, Promise<ClaudeCredentials | null>>()
const oauthFailures = new Map<string, number>()

const accountCacheMap = new Map<
    string,
    { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
    allAccounts = accounts
    accountCacheMap.clear()
    oauthFailures.clear()
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
                // Torn read from a concurrent writer. Rebuilding from {}
                // would drop other providers' credentials; skip and retry
                // on the next sync.
                log("sync_auth_json_skipped", {
                    path: authPath,
                    reason: "malformed or partially written auth.json",
                })
                return
            }
        }
    }
    // pi persists OAuth credentials as `{ type: "oauth", access, refresh,
    // expires }` keyed by provider id. Seeding the `anthropic` entry lets pi
    // use the Claude Code credentials with no separate /login.
    const entry = {
        type: "oauth",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
    const existing = auth.anthropic as Record<string, unknown> | undefined
    if (
        existing &&
        existing.type === entry.type &&
        existing.access === entry.access &&
        existing.refresh === entry.refresh &&
        existing.expires === entry.expires
    ) {
        return // unchanged; don't risk clobbering concurrent writers
    }
    auth.anthropic = entry
    const dir = dirname(authPath)
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    // Atomic replace so readers never see a partial file.
    const tmpPath = join(
        dir,
        `.auth.json.${process.pid}.${Date.now().toString(36)}.tmp`,
    )
    try {
        writeFileSync(tmpPath, JSON.stringify(auth, null, 2), {
            encoding: "utf-8",
            mode: 0o600,
        })
        if (process.platform !== "win32") {
            chmodSync(tmpPath, 0o600)
        }
        renameSync(tmpPath, authPath)
    } catch (err) {
        rmSync(tmpPath, { force: true })
        throw err
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

export async function refreshViaOAuth(
    refreshToken: string,
    signal?: AbortSignal,
): Promise<ClaudeCredentials | null> {
    signal?.throwIfAborted()
    if (!refreshToken || (oauthFailures.get(refreshToken) ?? 0) > Date.now()) {
        return null
    }
    const existing = oauthRefreshes.get(refreshToken)
    if (existing) return existing

    const pending = (async () => {
        try {
            log("refresh_started", { source: "oauth" })
            const response = await fetch(OAUTH_TOKEN_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                    grant_type: "refresh_token",
                    client_id: OAUTH_CLIENT_ID,
                    refresh_token: refreshToken,
                }).toString(),
                signal: signal
                    ? AbortSignal.any([
                          signal,
                          AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
                      ])
                    : AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
            })
            if (!response.ok) {
                // Rejected tokens cannot recover until the user re-authenticates.
                // Transient failures get a short cooldown instead.
                oauthFailures.set(
                    refreshToken,
                    response.status === 400 || response.status === 401
                        ? Infinity
                        : Date.now() + CREDENTIAL_CACHE_TTL_MS,
                )
                await response.body?.cancel()
                log("refresh_failed", {
                    source: "oauth",
                    status: response.status,
                })
                return null
            }
            const creds = parseOAuthResponse(
                await response.text(),
                refreshToken,
            )
            if (!creds) throw new Error("Invalid OAuth token response")
            oauthFailures.delete(refreshToken)
            log("refresh_success", { source: "oauth" })
            return creds
        } catch (err) {
            signal?.throwIfAborted()
            oauthFailures.set(
                refreshToken,
                Date.now() + CREDENTIAL_CACHE_TTL_MS,
            )
            log("refresh_failed", {
                source: "oauth",
                error: err instanceof Error ? err.message : String(err),
            })
            return null
        }
    })()
    oauthRefreshes.set(refreshToken, pending)
    try {
        return await pending
    } finally {
        oauthRefreshes.delete(refreshToken)
    }
}

export async function refreshIfNeeded(
    account?: ClaudeAccount,
    signal?: AbortSignal,
): Promise<ClaudeCredentials | null> {
    signal?.throwIfAborted()
    const target = account ?? getActiveAccount()
    if (!target) return null

    // Pick up external re-authentication on both file and Keychain sources.
    const onDisk = refreshAccount(target.source)
    if (onDisk) target.credentials = onDisk

    const creds = target.credentials
    if (creds.expiresAt > Date.now() + 60_000) return creds

    log("refresh_needed", {
        source: target.source,
        expiresAt: creds.expiresAt,
        expiresIn: creds.expiresAt - Date.now(),
    })

    const fresh = await refreshViaOAuth(creds.refreshToken, signal)
    if (!fresh) return null
    target.credentials = fresh
    writeBackCredentials(target.source, fresh)
    return fresh.expiresAt > Date.now() + 60_000 ? fresh : null
}

/**
 * Force a refresh of the active account's credentials and write the rotated
 * tokens back to storage. Used by pi's `oauth.refreshToken` hook, which is
 * invoked when the token stored in auth.json is at/near expiry.
 *
 * Re-reads the source first (the Claude CLI may have already rotated the
 * token), then falls back to a direct OAuth refresh.
 */
export async function forceRefreshActiveCredentials(
    signal?: AbortSignal,
): Promise<ClaudeCredentials | null> {
    const account = getActiveAccount()
    if (!account) return null

    accountCacheMap.delete(account.source)
    const fresh = await refreshIfNeeded(account, signal)
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
 * This does NOT trigger a refresh or re-read credential storage.
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
    if (cached && now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS) {
        return cached.creds.expiresAt > now + 60_000 ? cached.creds : null
    }

    // Synchronous API-key resolution must never start a network request or
    // a Claude agent run. Refresh happens only in the async OAuth lifecycle.
    const onDisk = refreshAccount(account.source)
    if (onDisk) account.credentials = onDisk
    const creds = account.credentials
    accountCacheMap.set(account.source, {
        creds,
        cachedAt: now,
    })
    return creds.expiresAt > now + 60_000 ? creds : null
}
