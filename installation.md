# Install pi-claude-auth

These instructions are designed for AI coding agents.

## Prerequisites

Before installing, verify you have pi and Claude Code installed and
authenticated.

### Check pi version

```bash
pi --version
```

You should see a version number (e.g., `0.78.0`).

### Check Claude Code credentials (macOS)

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

If this returns credentials, you're authenticated. If it fails or returns
nothing, try the fallback:

### Check Claude Code credentials (fallback for all platforms)

```bash
cat ~/.claude/.credentials.json
```

If this file exists and contains valid JSON, you're authenticated.

### If credentials don't exist

Run Claude Code to authenticate:

```bash
claude
```

This stores credentials in the Keychain (macOS) or
`~/.claude/.credentials.json` (other platforms).

## Installation

### Option A: Install as a pi package

```bash
pi install npm:pi-claude-auth
```

This installs the extension globally to `~/.pi/agent/npm/` and enables it. Use
`-l` for a project-local install (`.pi/npm/`).

### Option B: settings.json

Edit `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project) and
add the package to the `packages` array:

```json
{
    "packages": ["npm:pi-claude-auth@latest"]
}
```

Or run this command to do it automatically:

```bash
node -e "
const fs = require('fs'), path = require('path');
const p = path.join(process.env.PI_CODING_AGENT_DIR || path.join(require('os').homedir(), '.pi/agent'), 'settings.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.packages = [...new Set([...(Array.isArray(c.packages) ? c.packages : []), 'npm:pi-claude-auth@latest'])];
fs.mkdirSync(path.dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added npm:pi-claude-auth@latest to', p);
"
```

## Verification

Confirm the package is installed and enabled:

```bash
pi list
```

You should see `pi-claude-auth` in the list. Then run `pi`, open the model
selector (`/model` or Ctrl+L), and pick a Claude model. No `/login` or API key
is required — the extension has already seeded your Claude Code credentials.

## Upgrading

```bash
pi update npm:pi-claude-auth
```

## Done

The extension is now installed and configured. When you run pi, it
automatically uses your Claude Code credentials — no separate login needed.

## Troubleshooting

If you encounter issues, see the [main README troubleshooting section](README.md#troubleshooting).
