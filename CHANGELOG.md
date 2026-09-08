# Changelog

## Unreleased

### Bug Fixes

- Stop destroying other providers' credentials in `auth.json`. The 5-minute
  re-sync did an unlocked read-modify-write while pi truncates `auth.json`
  before rewriting it, so a torn/empty read was treated as "start fresh" and
  the file was rewritten with `anthropic` only — silently logging out
  providers such as `openai-codex`. The sync now takes pi's own
  `auth.json.lock` (`proper-lockfile`-compatible, still zero dependencies),
  writes atomically via temp file + rename, and skips the write entirely when
  the existing file cannot be parsed or the lock is held.

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
