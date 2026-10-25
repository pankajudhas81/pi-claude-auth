# Changelog

## Unreleased

### Fixed

- An expired login no longer freezes pi for up to ~120s on every
  model-catalog refresh (#7). Token refresh is asynchronous: the OAuth request
  runs in process with a 5s timeout (it used to spawn `process.execPath -e`,
  which is not Node when pi runs as a standalone binary), the `claude -p`
  fallback runs once, asynchronously, for at most 60s, and pi's
  `refreshToken` hook waits at most 8s (or until pi aborts it) while a slower
  refresh finishes in the background. Concurrent callers share one refresh; a
  refresh token the server rejected is not retried and skips the CLI, and one
  that failed otherwise is not retried for 5 minutes. `getApiKey` and startup
  never wait on a refresh.
- `refreshIfNeeded()` and `forceRefreshActiveCredentials()` now return
  promises; `getCachedCredentials()` no longer refreshes (it starts a
  background refresh and returns `null` while credentials are expired).

# [0.1.0](https://github.com/pankajudhas81/pi-claude-auth/compare/v0.0.1...v0.1.0) (2026-05-30)

## 0.0.1

### Features

- Initial release. Pi coding agent extension that authenticates against
  Anthropic using your existing Claude Code credentials — no separate login
  or API key needed.
- Reads OAuth credentials from the macOS Keychain (all
  `Claude Code-credentials*` entries) with automatic multi-account detection,
  falling back to `~/.claude/.credentials.json` on all platforms.
- Seeds and syncs credentials into pi's `~/.pi/agent/auth.json` so pi uses
  them with zero separate login. Background re-sync runs every 5 minutes.
- Refreshes expiring tokens directly via Anthropic's OAuth endpoint (zero LLM
  tokens consumed), falling back to the Claude CLI, and writes rotated tokens
  back to the Keychain or credentials file.
- Account switcher via `/login anthropic` when multiple Claude Code accounts
  are detected; selection persists across sessions.
- Diagnostic logging via `PI_CLAUDE_AUTH_DEBUG` with automatic secret
  redaction.
