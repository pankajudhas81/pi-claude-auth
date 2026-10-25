# Changelog

## Unreleased

### Fixed

- Newer models such as Opus 5 work again (#6). Anthropic rejects requests
  claiming a Claude Code version below a per-model minimum
  (`claude_code_version_too_old`); the pinned `2.1.160` was below it. The
  extension now reads `claude --version` once at startup and sends that
  version when it is newer than the built-in floor, raised to `2.1.304`.
  `ANTHROPIC_CLI_VERSION` still overrides both. Version detection approach
  from forks by @alberti42, @fdietze and @gfrotcom.
- The README model table and `pnpm run test:models` list match pi 1.4.0's
  Anthropic catalog: retired Claude 4.0/4.1 models removed, Opus 5/5.5,
  Sonnet 5/5.5, Haiku 5.5 and Fable 5/5.1 added. `test:models` sends the
  extension's own user-agent instead of a hard-coded `2.1.112`.

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
