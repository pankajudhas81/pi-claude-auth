# pi-claude-auth

Self-contained Anthropic auth for the [pi coding agent](https://pi.dev) using
your existing Claude Code credentials — no separate login or API key needed.

## Quick start

```bash
pi install npm:pi-claude-auth
```

Restart pi, pick a model with `/model` (or Ctrl+L). Done — your Claude Code
credentials are already seeded.

The npm command installs the upstream release. To use the fixes in this fork:

```bash
pi install git:github.com/itsmingjie/pi-claude-auth
```

## Prerequisites

> **Claude Code must be installed and authenticated first.**
>
> The extension reads from your macOS Keychain entry
> `Claude Code-credentials`. Run `claude` at least once so the entry exists.
> On Linux/Windows, `~/.claude/.credentials.json` is used instead.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
  installed and authenticated (run `claude` at least once)
- [pi](https://pi.dev) installed
  (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`)
- macOS preferred (uses Keychain). Linux and Windows work via the credentials
  file fallback.

## Installation

### Option A: pi package manager (recommended)

```bash
pi install npm:pi-claude-auth
```

Installs the extension globally to `~/.pi/agent/npm/`. Use `-l` for a
project-local install.

### Option B: Declare in settings.json (dotfiles-friendly)

Add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
    "packages": ["npm:pi-claude-auth@latest"]
}
```

Then just run `pi`. The extension loads automatically.

### Option C: Let an LLM do it

Paste this into any LLM agent (pi, Claude Code, Cursor, etc.):

```
Install the pi-claude-auth package and configure it by following:
https://raw.githubusercontent.com/pankajudhas81/pi-claude-auth/main/installation.md
```

### Updating

```bash
pi update npm:pi-claude-auth
```

## Verify it's working

After installation, run:

```bash
pi config
```

You should see the extension listed:

```
npm:pi-claude-auth (user)
  Extensions
    [x] src/index.ts
```

Then start pi and pick any Claude model with `/model`. If it responds, auth is
working.

## Usage

Run `pi`, then pick a Claude model with `/model` (or Ctrl+L). The extension has
already seeded your Claude Code credentials, so there is nothing else to do — no
`/login`, no API key. Tokens refresh in the background and rotated tokens are
written back to Claude Code's storage.

If your Claude Code credentials aren't OAuth-based, the extension stays out of
the way and pi falls through to its standard Anthropic auth.

## Why pi-claude-auth?

There are several good community projects solving Anthropic auth for pi (see
[Acknowledgements](#acknowledgements)). Here's what makes this one different:

- **Zero-login** — if Claude Code is authenticated, pi works immediately. No
  browser OAuth dance, no `/login`, no API key. Install and go.
- **Keychain-native** — reads directly from macOS Keychain (the same secure
  storage Claude Code uses). No credential files to manage on macOS.
- **Multi-account switching** — detects all Claude Code accounts automatically.
  Switch via `/login` when you have multiple accounts (Pro, Max, etc.).
- **Background sync** — re-syncs auth every 5 minutes and writes refreshed
  tokens back to Claude Code's storage, keeping both tools in sync.
- **Bounded async token refresh** — refreshes directly via Anthropic's OAuth
  endpoint with a five-second timeout, without launching a Claude agent.
  Rejected refresh tokens require manual re-authentication; transient failures
  have a 30-second retry cooldown.

If you prefer a browser-based OAuth flow or need relay/caching features,
check out [pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth)
or [@cortexkit/pi-anthropic-auth](https://pi.dev/packages/@cortexkit/pi-anthropic-auth)
— both are solid options.

## Supported models

The extension uses pi's Anthropic model catalog; the smoke-test script does not
control which models appear in `/model`. Opus 5 and newer models are available
when your pi version and Claude subscription support them. Update pi if a model
is missing, and check the Claude Code version pin below for version-gate errors.

These are the 16 smoke-test targets, not a claim of verified account access.
Run `pnpm run test:models` to verify them against your account.

| Model                      |
| -------------------------- |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-opus-5-5            |
| claude-fable-5             |
| claude-fable-5-1           |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |
| claude-sonnet-5-5          |

## Credential sources

The extension checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts
   are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

## Multiple accounts (macOS)

If you have multiple Claude Code accounts authenticated on macOS, the extension
detects all of them from the Keychain automatically. Each account is labeled by
its subscription tier (Claude Pro, Claude Max, etc.). Items sharing a service
name remain separate when their Keychain account names differ. Without a saved
selection, the credential with the latest expiry is used by default.

To switch accounts:

```
/login
```

Select the `anthropic` provider, then pick the account you want. Your selection
is persisted across sessions in `~/.pi/agent/claude-account-source.txt`. If only
one account is found, the picker is skipped.

## Troubleshooting

| Problem                            | Solution                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "No Claude Code credentials found" | Run `claude` to authenticate with Claude Code first                                                                     |
| "Keychain is locked"               | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                    |
| "Token expired and refresh failed" | Re-authenticate by running `claude`, then retry. The extension never starts a Claude agent to refresh tokens.           |
| Not working on Linux/Windows       | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it                                                  |
| Keychain access denied             | Grant access when macOS prompts you                                                                                     |
| Keychain read timed out            | Restart Keychain Access (can happen on macOS Tahoe)                                                                     |
| Package not updating               | Run `pi update npm:pi-claude-auth` for upstream, or `pi update git:github.com/itsmingjie/pi-claude-auth` for this fork. |

### Claude Code version pinning

The Claude Code version is pinned to `2.1.280` for the user-agent and billing header.
If Anthropic rejects a model with `claude_code_version_too_old`, or billing reverts
to extra usage after a Claude Code update, override with the required version:

```bash
export ANTHROPIC_CLI_VERSION=<new-version>
```

or update the package:

```bash
pi update npm:pi-claude-auth
```

### Diagnostic logging

If you hit auth errors that are hard to reproduce, enable debug logging to
capture the full auth flow:

```bash
export PI_CLAUDE_AUTH_DEBUG=1
```

Restart pi and reproduce the issue. The extension writes structured JSON logs to
`~/.pi/agent/pi-claude-auth-debug.log`. All secrets (tokens, API keys) are
automatically redacted — the log file is safe to share when reporting an issue.

To write logs to a custom path:

```bash
export PI_CLAUDE_AUTH_DEBUG=/tmp/pi-claude-auth-debug.log
```

Disable when done:

```bash
unset PI_CLAUDE_AUTH_DEBUG
```

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth                # refresh + write-back (safe)
pnpm run validate:oauth -- --dry-run   # show what would be sent, no request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and
writes the new tokens back to storage. Refresh tokens rotate on each use, so
write-back is enabled by default to keep your stored credentials valid.

## Environment variables

| Variable                | Description                                                             | Default       |
| ----------------------- | ----------------------------------------------------------------------- | ------------- |
| `PI_CODING_AGENT_DIR`   | pi's config directory (where `auth.json` lives)                         | `~/.pi/agent` |
| `PI_CLAUDE_AUTH_DEBUG`  | Enable diagnostic logging (`1` for default path, or a custom file path) | disabled      |
| `ANTHROPIC_CLI_VERSION` | Claude CLI version for user-agent and billing headers                   | `2.1.280`     |

## How it works

This is a pi [extension](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
(packaged as a pi package) that sources Anthropic credentials from Claude Code
instead of asking you to log in again.

On startup it reads your Claude Code OAuth tokens from the macOS Keychain (or
`~/.claude/.credentials.json` on other platforms), caches them in memory with a
30-second TTL, and seeds them into pi's `~/.pi/agent/auth.json` under the
`anthropic` provider. pi then uses those credentials with **zero separate
login**. On macOS, multiple Claude Code accounts are detected automatically and
can be switched via `/login`.

It overrides the `anthropic` provider's OAuth lifecycle: when a token is near
expiry, pi delegates refresh to this extension, which refreshes directly via
Anthropic's OAuth endpoint asynchronously (zero LLM tokens consumed), with a
five-second timeout, and writes rotated tokens **back** to the Keychain or
credentials file so Claude Code and pi stay in sync. Failed refreshes never
launch a Claude agent. Rejected tokens are not retried until the stored refresh
token changes; temporary errors are retried after a 30-second cooldown. Both
Keychain and file credentials are re-read so an external login is picked up.
A background re-sync runs every 5 minutes. pi's built-in Anthropic provider
handles the Claude Code request fidelity (identity, beta flags, tool naming)
for OAuth tokens.

### Technical details

- Reads all `Claude Code-credentials*` Keychain entries on macOS (labeled by
  subscription tier), falling back to `~/.claude/.credentials.json`
- Seeds the active account's tokens into `~/.pi/agent/auth.json` as an
  `{ type: "oauth", access, refresh, expires }` entry under `anthropic`, so pi
  uses them with no separate `/login`
- Registers an `anthropic` OAuth provider override via
  `pi.registerProvider("anthropic", { oauth })`:
    - `login` reads the Keychain/file (no browser) and exposes an account picker
      when multiple accounts exist
    - `refreshToken` refreshes asynchronously via `POST https://claude.ai/v1/oauth/token`
      (no LLM tokens), and writes rotated tokens back to the exact Keychain item
      (macOS) or credentials file (other platforms)
    - `getApiKey` returns the freshest cached access token
- Re-syncs `auth.json` every 5 minutes (sync never triggers a refresh; refresh
  is lazy, only when pi requests it or a request needs a fresh token)
- pi's built-in Anthropic provider applies the Claude Code identity, beta flags,
  and tool-name conventions for OAuth tokens, so requests look like Claude Code
- If credentials aren't OAuth-based or can't be read, the extension disables
  itself and pi continues with its standard Anthropic auth

## Acknowledgements

This project is motivated by and copies patterns from
[opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)
by Griffin Martin. That project solved the same problem for
[opencode](https://github.com/nichochar/opencode) — reusing Claude Code OAuth
credentials so you don't need a separate login. We adopted the same approach
(Keychain reading, token refresh, credential seeding) and adapted it for pi's
extension API.

The community has built several other great solutions worth checking out:

- **[pi-anthropic-oauth](https://github.com/leohenon/pi-anthropic-oauth)** by
  Leo Henon — a browser-based OAuth flow for pi. Uses a local callback server
  for a full OAuth dance via `/login anthropic`. Different approach from ours
  (browser login vs. Keychain reading), well-maintained, and popular (39 stars).
  If you prefer authenticating directly through Anthropic's login page rather
  than piggybacking on Claude Code credentials, this is a great choice.

- **[@cortexkit/pi-anthropic-auth](https://pi.dev/packages/@cortexkit/pi-anthropic-auth)**
  by ismeth / CortexKit — a shared-core monorepo supporting both pi and OpenCode
  through `@cortexkit/anthropic-auth-core`. Offers advanced features like relay
  proxying via Cloudflare Workers, prompt caching controls (`/claude-cache`),
  quota management, fast-mode for Opus, and routing strategies. The most
  feature-rich option in this space (1,540 downloads/mo). If you need caching,
  relay, or quota features, check this one out.

All three projects (and ours) exist because the community wants to use pi with
Claude Pro/Max subscriptions. Different approaches, same goal. Pick whichever
fits your workflow best.

## Disclaimer

This extension uses Claude Code's OAuth credentials to authenticate with
Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max
subscription tokens should only be used with official Anthropic clients. This
extension exists as a community workaround and may stop working if Anthropic
changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
