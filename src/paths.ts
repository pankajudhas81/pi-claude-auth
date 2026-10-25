import { homedir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Resolve pi's agent config directory.
 *
 * Honors PI_CODING_AGENT_DIR the way pi itself does, including expansion of a
 * leading `~`, falling back to the default `~/.pi/agent`. All credential and
 * log artifacts live under this directory so the extension stays consistent
 * with pi's layout.
 */
export function getPiAgentDir(): string {
    const envDir = process.env.PI_CODING_AGENT_DIR
    if (!envDir) return join(homedir(), ".pi", "agent")
    if (envDir === "~") return homedir()
    if (
        envDir.startsWith("~/") ||
        (process.platform === "win32" && envDir.startsWith("~\\"))
    ) {
        return join(homedir(), envDir.slice(2))
    }
    return envDir
}

/**
 * Absolute path to pi's auth.json (where credentials are persisted).
 *
 * Resolved exactly like the path pi locks, so `<path>.lock` names the same
 * lock directory pi uses.
 */
export function getAuthJsonPath(): string {
    return resolve(getPiAgentDir(), "auth.json")
}
