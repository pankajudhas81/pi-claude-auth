# Changelog

## Unreleased

### Fixed

- `auth.json` sync now takes the same `proper-lockfile` lock pi itself uses
  for that file, so a background sync can no longer interleave with a pi
  credential write (for example a `/login` completed by another pi process)
  and silently drop a provider credential pi just stored.
- A malformed `auth.json` is now preserved in an `auth.json.corrupt-*`
  sibling backup and left untouched instead of being reset to `{}` +
  `anthropic`, which wiped every other provider's credentials.
- `auth.json` writes use a unique private temporary directory and atomic
  rename. Cleanup covers both temporary-write and rename failures.
- Initialization now checks for a missing `auth.json` only after taking the
  lock, avoiding a pre-lock placeholder write that could truncate another
  writer's credentials. Existing empty or whitespace-only files are preserved
  rather than treated as missing. Separate-process regression tests cover
  contention with a `proper-lockfile` writer and preservation of its provider.
- This consolidates the lock-before-read initialization and failure-cleanup
  approach from [PR #8](https://github.com/pankajudhas81/pi-claude-auth/pull/8),
  commit `ef5e0f4bf596e349cf68686d01c8f6489559ba3c`, while retaining the
  `proper-lockfile` dependency instead of PR8's custom lock implementation.
  The concurrency tests reproduce synthetic races, not a verified cause of
  any production credential loss.

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
