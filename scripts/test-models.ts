/**
 * Smoke-test each supported Claude model against your Claude Code account.
 *
 * Sends a tiny Claude-Code-shaped request per model using your OAuth access
 * token and reports pass/fail. Updates the "Supported models" table in
 * README.md with the models that pass.
 *
 * Usage:
 *   pnpm run test:models
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
    getCachedCredentials,
    initAccounts,
    setActiveAccountSource,
} from "../src/credentials.ts"
import { readAllClaudeAccounts } from "../src/keychain.ts"

// The supported model set. Keep this in sync with the README table.
const MODELS = [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-0",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
]

const API_URL = "https://api.anthropic.com/v1/messages"
const SYSTEM_IDENTITY =
    "You are Claude Code, Anthropic's official CLI for Claude."
const CLI_VERSION = process.env.ANTHROPIC_CLI_VERSION ?? "2.1.258"

const c = {
    green: (s: string) => `\x1b[32m${s}\x1b[0m`,
    red: (s: string) => `\x1b[31m${s}\x1b[0m`,
    yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
    dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
    bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

interface ModelResult {
    model: string
    status: "pass" | "fail"
    timeMs: number
    error?: string
}

function buildHeaders(accessToken: string): Headers {
    const headers = new Headers()
    headers.set("content-type", "application/json")
    headers.set("authorization", `Bearer ${accessToken}`)
    headers.set("anthropic-version", "2023-06-01")
    headers.set(
        "anthropic-beta",
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    )
    headers.set("anthropic-dangerous-direct-browser-access", "true")
    headers.set("x-app", "cli")
    headers.set("user-agent", `claude-cli/${CLI_VERSION} (external, cli)`)
    return headers
}

async function testModel(
    modelId: string,
    accessToken: string,
): Promise<ModelResult> {
    const start = Date.now()
    const body = JSON.stringify({
        model: modelId,
        max_tokens: 16,
        system: [{ type: "text", text: SYSTEM_IDENTITY }],
        messages: [{ role: "user", content: "hi" }],
    })

    let response: Response
    try {
        response = await fetch(API_URL, {
            method: "POST",
            headers: buildHeaders(accessToken),
            body,
        })
    } catch (err) {
        return {
            model: modelId,
            status: "fail",
            timeMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
        }
    }

    const timeMs = Date.now() - start
    if (response.ok) {
        return { model: modelId, status: "pass", timeMs }
    }

    let error = `HTTP ${response.status}`
    try {
        const parsed = JSON.parse(await response.text()) as {
            error?: { message?: string }
        }
        if (parsed.error?.message) error = parsed.error.message
    } catch {
        // keep HTTP status
    }
    return { model: modelId, status: "fail", timeMs, error }
}

function printResult(r: ModelResult): void {
    const icon = r.status === "pass" ? c.green("✓") : c.red("✗")
    const name = r.model.padEnd(32)
    const time = c.dim(`${(r.timeMs / 1000).toFixed(1)}s`)
    let line = `  ${icon}  ${name} ${time}`
    if (r.error) line += `\n       ${c.red(r.error)}`
    console.log(line)
}

function updateReadme(results: ModelResult[]): void {
    const here = dirname(fileURLToPath(import.meta.url))
    const readmePath = join(here, "..", "README.md")
    if (!existsSync(readmePath)) return

    const readme = readFileSync(readmePath, "utf-8")
    const supported = results
        .filter((r) => r.status === "pass")
        .map((r) => r.model)
        .sort((a, b) => a.localeCompare(b))

    const rows = supported.map((m) => `| ${m} |`).join("\n")
    const section = `## Supported models

${supported.length} supported models. Run \`pnpm run test:models\` to verify against your account.

| Model |
| ----- |
${rows}`

    const start = readme.indexOf("## Supported models")
    if (start === -1) return
    const next = readme.indexOf("\n## ", start + 1)
    const updated =
        next === -1
            ? `${readme.slice(0, start) + section}\n`
            : readme.slice(0, start) + section + "\n\n" + readme.slice(next + 1)

    writeFileSync(readmePath, updated, "utf-8")
    console.log(c.dim("README.md updated with supported models"))
}

function writeResults(results: ModelResult[]): void {
    const here = dirname(fileURLToPath(import.meta.url))
    const outPath = join(here, "..", "test-results", "model-smoke-test.json")
    const dir = dirname(outPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const passed = results.filter((r) => r.status === "pass").length
    const output = {
        date: new Date().toISOString(),
        summary: {
            tested: results.length,
            passed,
            failed: results.length - passed,
        },
        results: results.map((r) => ({
            model: r.model,
            status: r.status,
            timeMs: r.timeMs,
            error: r.error ?? null,
        })),
    }
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8")
    console.log(c.dim("Results written to test-results/model-smoke-test.json"))
}

async function main(): Promise<void> {
    console.log(c.bold("Model Smoke Test"))
    console.log(`${"=".repeat(50)}\n`)

    const accounts = readAllClaudeAccounts()
    if (accounts.length === 0) {
        console.error(
            c.red("No Claude Code credentials found. Run `claude` first."),
        )
        process.exit(1)
    }
    initAccounts(accounts)
    setActiveAccountSource(accounts[0].source)

    const creds = getCachedCredentials()
    if (!creds) {
        console.error(
            c.red("Credentials are expired and could not be refreshed."),
        )
        process.exit(1)
    }

    const results: ModelResult[] = []
    for (const modelId of MODELS) {
        const result = await testModel(modelId, creds.accessToken)
        results.push(result)
        printResult(result)
    }

    const passed = results.filter((r) => r.status === "pass").length
    console.log(`\n${"=".repeat(50)}`)
    const summary = `Summary: ${passed}/${results.length} passed`
    console.log(
        passed === results.length ? c.green(summary) : c.yellow(summary),
    )

    writeResults(results)
    updateReadme(results)
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(
            c.red(`Fatal error: ${err instanceof Error ? err.message : err}`),
        )
        process.exit(1)
    })
