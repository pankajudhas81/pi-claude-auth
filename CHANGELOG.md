# Changelog

## Unreleased

### Fixed

- Expired credentials no longer shadow a valid login when several Keychain
  items share the `Claude Code-credentials` service (#4). Items are read by
  service and account (`security -s <service> -a <account>`), every item is
  listed in the `/login` picker, the item that expires last becomes the
  default, and write-back updates exactly the item that was read. Account
  names that `security` prints hex-encoded (non-ASCII macOS usernames) are
  decoded. A selection saved by an earlier version, which names only the
  service, resolves to that service's freshest item. Based on PR #5 by
  @mattsegura.

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
