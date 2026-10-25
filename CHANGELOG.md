# Changelog

## Unreleased

### Fixed

- `auth.json` sync no longer loses other providers' credentials. Each update
  takes the same `auth.json.lock` pi takes (so it cannot interleave with a pi
  write in any process), leaves a file it cannot parse byte-for-byte untouched
  instead of resetting it to `anthropic` only, replaces the file atomically
  through a temp file and rename (a symlinked `auth.json` keeps its link), and
  skips the write when the `anthropic` entry is already current.
  `PI_CODING_AGENT_DIR` values starting with `~` resolve to the same path pi
  uses. Consolidates PRs #3, #8 and #9.
- `syncAuthJson()` returns `"written" | "unchanged" | "locked" | "unreadable" |
  "failed"` instead of throwing, so a busy lock or an unreadable file can no
  longer abort extension startup.
- `login` and `refreshToken` no longer write `auth.json` themselves: pi persists
  the credentials they return, and `refreshToken` runs while pi holds the
  `auth.json` lock.

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
