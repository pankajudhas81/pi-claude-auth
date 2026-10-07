import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { afterEach, mock, test, type TestContext } from "node:test"
import {
    buildAccountLabels,
    decodeSource,
    encodeSource,
    readAllClaudeAccounts,
    refreshAccount,
    updateCredentialBlob,
    writeBackCredentials,
} from "./keychain.ts"

const platform = Object.getOwnPropertyDescriptor(process, "platform")!

afterEach(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
    Object.defineProperty(process, "platform", platform)
})

function mockSecurity(t: TestContext, run: (args: string[]) => string): void {
    Object.defineProperty(process, "platform", { value: "darwin" })
    t.mock.method(childProcess, "execFileSync", (file, args) => {
        assert.equal(file, "/usr/bin/security")
        return run(args as string[])
    })
    syncBuiltinESMExports()
}

function dumpItem(service: string, account: string): string {
    return `keychain: "/test/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="${account}"
    "svce"<blob>="${service}"
`
}

test("buildAccountLabels: single account uses bare tier label", () => {
    const labels = buildAccountLabels([
        {
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
            subscriptionType: "max",
        },
    ])
    assert.deepEqual(labels, ["Claude Max"])
})

test("buildAccountLabels: missing subscriptionType falls back to Claude", () => {
    const labels = buildAccountLabels([
        { accessToken: "a", refreshToken: "r", expiresAt: 0 },
    ])
    assert.deepEqual(labels, ["Claude"])
})

test("buildAccountLabels: duplicate tiers get numeric suffixes", () => {
    const labels = buildAccountLabels([
        {
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
            subscriptionType: "pro",
        },
        {
            accessToken: "b",
            refreshToken: "s",
            expiresAt: 0,
            subscriptionType: "pro",
        },
    ])
    assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2"])
})

test("updateCredentialBlob: updates a wrapped claudeAiOauth blob", () => {
    const input = JSON.stringify({
        claudeAiOauth: {
            accessToken: "old",
            refreshToken: "oldR",
            expiresAt: 1,
            subscriptionType: "max",
        },
    })
    const out = updateCredentialBlob(input, {
        accessToken: "new",
        refreshToken: "newR",
        expiresAt: 2,
    })
    assert.ok(out)
    const parsed = JSON.parse(out) as {
        claudeAiOauth: {
            accessToken: string
            refreshToken: string
            expiresAt: number
            subscriptionType: string
        }
    }
    assert.equal(parsed.claudeAiOauth.accessToken, "new")
    assert.equal(parsed.claudeAiOauth.refreshToken, "newR")
    assert.equal(parsed.claudeAiOauth.expiresAt, 2)
    // Preserves unrelated fields
    assert.equal(parsed.claudeAiOauth.subscriptionType, "max")
})

test("updateCredentialBlob: updates a flat blob", () => {
    const input = JSON.stringify({
        accessToken: "old",
        refreshToken: "oldR",
        expiresAt: 1,
    })
    const out = updateCredentialBlob(input, {
        accessToken: "new",
        refreshToken: "newR",
        expiresAt: 2,
    })
    assert.ok(out)
    const parsed = JSON.parse(out) as { accessToken: string }
    assert.equal(parsed.accessToken, "new")
})

test("updateCredentialBlob: returns null for malformed json", () => {
    assert.equal(
        updateCredentialBlob("not json", {
            accessToken: "a",
            refreshToken: "r",
            expiresAt: 0,
        }),
        null,
    )
})

test("readAllClaudeAccounts: reads each exact item and defaults to freshest", (t) => {
    mockSecurity(t, (args) => {
        if (args[0] === "dump-keychain") {
            return (
                dumpItem("Claude Code-credentials", "default") +
                dumpItem("Claude Code-credentials", "alice")
            )
        }
        assert.equal(args[0], "find-generic-password")
        assert.ok(args.includes("-a"))
        assert.ok(args.includes("-w"))
        const account = args[args.indexOf("-a") + 1]
        return JSON.stringify({
            accessToken: account,
            refreshToken: "refresh",
            expiresAt: account === "alice" ? Date.now() + 3_600_000 : 1,
            subscriptionType: "max",
        })
    })
    const accounts = readAllClaudeAccounts()
    assert.equal(accounts.length, 2)
    assert.equal(decodeSource(accounts[0].source).account, "alice")
    assert.deepEqual(
        accounts.map((a) => a.label),
        ["Claude Max 1", "Claude Max 2"],
    )
})

test("refreshAccount: exact account is passed as argv, never shell text", (t) => {
    const account = "alice; $(echo test)"
    mockSecurity(t, (args) => {
        assert.deepEqual(args, [
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-a",
            account,
            "-w",
        ])
        return JSON.stringify({
            accessToken: "fresh",
            refreshToken: "r",
            expiresAt: 100,
        })
    })
    assert.equal(
        refreshAccount(
            encodeSource({ service: "Claude Code-credentials", account }),
        )?.accessToken,
        "fresh",
    )
})

test("writeBackCredentials: read and write target the same item", (t) => {
    const writes: string[][] = []
    mockSecurity(t, (args) => {
        if (args[0] === "find-generic-password") {
            assert.deepEqual(args, [
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-a",
                "alice",
                "-w",
            ])
            return JSON.stringify({
                claudeAiOauth: {
                    accessToken: "old",
                    refreshToken: "r",
                    expiresAt: 1,
                    subscriptionType: "max",
                },
            })
        }
        writes.push(args)
        return ""
    })
    assert.equal(
        writeBackCredentials(
            encodeSource({
                service: "Claude Code-credentials",
                account: "alice",
            }),
            {
                accessToken: "new",
                refreshToken: "new-r",
                expiresAt: 2,
            },
        ),
        true,
    )
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].slice(0, 5), [
        "add-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        "alice",
    ])
    const blob = JSON.parse(writes[0][6])
    assert.equal(blob.claudeAiOauth.accessToken, "new")
    assert.equal(blob.claudeAiOauth.subscriptionType, "max")
})

test("legacy write-back: does not invent an account when metadata is missing", (t) => {
    mockSecurity(t, (args) => {
        assert.equal(args[0], "find-generic-password")
        assert.equal(args.includes("-w"), false)
        return "no account metadata"
    })
    assert.equal(
        writeBackCredentials("Claude Code-credentials", {
            accessToken: "new",
            refreshToken: "r",
            expiresAt: 2,
        }),
        false,
    )
})
