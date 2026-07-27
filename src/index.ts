import type {
    ExtensionAPI,
    ExtensionContext,
    OAuthCredential,
    ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import {
    forceRefreshActiveCredentials,
    getCachedCredentials,
    getCredentialsForSync,
    initAccounts,
    loadPersistedAccountSource,
    refreshAccountsList,
    saveAccountSource,
    setActiveAccountSource,
    syncAuthJson,
    type ClaudeCredentials,
} from "./credentials.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import { buildUserAgent } from "./signing.ts"
import { injectBillingHeader, sanitizeStrictToolSchemas } from "./transforms.ts"

export {
    getCachedCredentials,
    syncAuthJson,
    refreshAccountsList,
    type ClaudeCredentials,
} from "./credentials.ts"
export { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"

// Derive the OAuth types from the official ProviderConfig so the extension
// stays fully typed without importing @earendil-works/pi-ai directly.
type OAuthConfig = NonNullable<ProviderConfig["oauth"]>
type OAuthCreds = Awaited<ReturnType<OAuthConfig["refreshToken"]>>
type LoginCallbacks = Parameters<OAuthConfig["login"]>[0]

const PROVIDER_ID = "anthropic"
const PROVIDER_LABEL = "Claude Code (subscription)"
const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

function toOAuthCreds(creds: ClaudeCredentials): OAuthCreds {
    return {
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }
}

/**
 * Inject the active Claude Code credentials into pi's in-memory AuthStorage.
 *
 * pi builds its AuthStorage at startup, before extensions load, so writing
 * auth.json on disk alone is not picked up for the current session (and an
 * existing ANTHROPIC_API_KEY env var would shadow it). Setting the credential
 * directly on the live AuthStorage makes pi use the Claude Code OAuth token
 * immediately — and AuthStorage persists it to auth.json too.
 */
function applyCredential(ctx: ExtensionContext): boolean {
    const creds = getCachedCredentials()
    if (!creds) return false

    const credential: OAuthCredential = {
        type: "oauth",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
    }

    try {
        ctx.modelRegistry.authStorage.set(PROVIDER_ID, credential)
        log("credential_applied", { provider: PROVIDER_ID })
        return true
    } catch (err) {
        log("credential_apply_error", {
            error: err instanceof Error ? err.message : String(err),
        })
        return false
    }
}

/**
 * pi-claude-auth extension.
 *
 * Reads your existing Claude Code OAuth credentials (macOS Keychain or
 * `~/.claude/.credentials.json`) and makes pi authenticate as Claude Code with
 * no separate login:
 *
 * - Injects the credentials into pi's live AuthStorage on every session start
 *   (and seeds auth.json) so they take priority over any ANTHROPIC_API_KEY.
 * - Overrides the `anthropic` provider's OAuth lifecycle: refresh goes through
 *   Anthropic's OAuth endpoint (with Claude CLI fallback) and rotated tokens
 *   are written back to the Keychain / credentials file. Multiple accounts are
 *   selectable via `/login`.
 * - Overrides the user-agent to the full Claude Code form and injects the
 *   Claude Code billing header, so requests bill against the Claude Pro/Max
 *   subscription plan rather than pay-as-you-go API credits or extra usage.
 *
 * pi's built-in Anthropic provider supplies the remaining Claude Code fidelity
 * (identity prompt, beta flags, tool naming) for OAuth tokens.
 */
const extension = async (pi: ExtensionAPI): Promise<void> => {
    initLogger()

    let accounts: ClaudeAccount[] = []
    try {
        accounts = readAllClaudeAccounts()
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log("extension_init_error", { error })
        console.warn(
            "pi-claude-auth: Failed to read Claude Code credentials:",
            error,
        )
        return
    }

    initAccounts(accounts)

    if (accounts.length === 0) {
        log("extension_init_no_accounts", { reason: "no credentials found" })
        console.warn(
            "pi-claude-auth: No Claude Code credentials found. Run `claude` to authenticate first.",
        )
        return
    }

    const persistedSource = loadPersistedAccountSource()
    const defaultAccount =
        (persistedSource &&
            accounts.find((a) => a.source === persistedSource)) ||
        accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("extension_init", {
        accountCount: accounts.length,
        sources: accounts.map((a) => a.source),
        activeSource: defaultAccount.source,
    })

    // Seed auth.json so pi uses the Claude Code credentials with zero login.
    const initialCreds = getCachedCredentials()
    if (initialCreds) {
        syncAuthJson(initialCreds)
    } else {
        console.warn(
            "pi-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
        )
    }

    // Keep auth.json synced with current credentials (no refresh triggered).
    const syncTimer = setInterval(() => {
        try {
            const creds = getCredentialsForSync()
            if (creds) syncAuthJson(creds)
        } catch {
            // Non-fatal
        }
    }, SYNC_INTERVAL)
    syncTimer.unref()

    const oauth: OAuthConfig = {
        name: PROVIDER_LABEL,

        async login(callbacks: LoginCallbacks): Promise<OAuthCreds> {
            const latestAccounts = refreshAccountsList()
            if (latestAccounts.length === 0) {
                throw new Error(
                    "No Claude Code credentials found. Run `claude` to authenticate first.",
                )
            }

            const currentSource =
                loadPersistedAccountSource() ?? defaultAccount.source
            let chosen =
                latestAccounts.find((a) => a.source === currentSource) ??
                latestAccounts[0]

            // Offer an account picker when multiple Claude Code accounts exist.
            if (latestAccounts.length > 1 && callbacks.onSelect) {
                const picked = await callbacks.onSelect({
                    message: "Select which Claude Code account to use:",
                    options: latestAccounts.map((a) => ({
                        id: a.source,
                        label:
                            a.source === currentSource
                                ? `${a.label} (active)`
                                : a.label,
                    })),
                })
                if (picked) {
                    chosen =
                        latestAccounts.find((a) => a.source === picked) ??
                        chosen
                }
            }

            setActiveAccountSource(chosen.source)
            saveAccountSource(chosen.source)

            const creds = getCachedCredentials() ?? chosen.credentials
            syncAuthJson(creds)
            log("login", { source: chosen.source, label: chosen.label })
            return toOAuthCreds(creds)
        },

        async refreshToken(credentials: OAuthCreds): Promise<OAuthCreds> {
            const fresh = forceRefreshActiveCredentials()
            if (fresh) {
                syncAuthJson(fresh)
                return toOAuthCreds(fresh)
            }
            log("refresh_token_fallback", {
                reason: "force refresh returned null",
            })
            // Return the supplied credentials unchanged so pi can surface a
            // clear auth error rather than crashing.
            return credentials
        },

        getApiKey(credentials: OAuthCreds): string {
            const latest = getCachedCredentials()
            return latest?.accessToken ?? credentials.access
        },
    }

    // Override the user-agent to the full Claude Code form
    // (`claude-cli/<version> (external, <entrypoint>)`). pi sends a bare
    // `claude-cli/<version>`, which Anthropic's plan-billing validation does
    // not accept — without this the request bills against extra usage instead
    // of the subscription plan.
    pi.registerProvider(PROVIDER_ID, {
        oauth,
        headers: { "user-agent": buildUserAgent() },
    })

    // Inject the live credential into pi's AuthStorage on every session start.
    // This is what makes pi actually use the Claude Code OAuth token (and
    // therefore enter Claude Code stealth mode) instead of falling back to an
    // ANTHROPIC_API_KEY env var or reporting "No API key found".
    pi.on("session_start", async (_event, ctx) => {
        applyCredential(ctx)
    })

    // Rewrite the outgoing Anthropic payload:
    //
    // 1. Strip JSON Schema keywords that Anthropic's strict tool validator
    //    rejects (e.g. `minimum`/`maximum` on an integer), which otherwise
    //    fail the whole request with a 400 before it reaches the model.
    // 2. Inject the Claude Code billing header so requests bill against the
    //    Claude Pro/Max subscription rather than pay-as-you-go API credits.
    //    pi's built-in Anthropic provider supplies the identity, betas, and
    //    user-agent for OAuth tokens but not this header.
    //
    // Both transforms mutate the payload in place, so a single payload is
    // returned when either applied.
    pi.on("before_provider_request", (event) => {
        let payload: unknown

        try {
            const sanitized = sanitizeStrictToolSchemas(event.payload)
            if (sanitized) payload = sanitized
        } catch (err) {
            log("tool_schema_sanitize_error", {
                error: err instanceof Error ? err.message : String(err),
            })
        }

        try {
            const updated = injectBillingHeader(event.payload)
            if (updated) {
                log("billing_header_injected", {})
                payload = updated
            }
        } catch (err) {
            log("billing_header_error", {
                error: err instanceof Error ? err.message : String(err),
            })
        }

        return payload
    })

    log("provider_registered", { provider: PROVIDER_ID })
}

export const ClaudeAuthExtension = extension
export default extension
