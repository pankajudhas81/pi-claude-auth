import assert from "node:assert/strict"
import { test } from "node:test"
import {
    buildAccountLabels,
    decodeSource,
    encodeSource,
    parseKeychainDump,
    updateCredentialBlob,
} from "./keychain.ts"

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

// --- Multi-account / same-service handling -------------------------------
//
// A real dump-keychain excerpt from a machine where Claude Code had written
// credentials under two different account names. Reading such a service
// without -a returns an arbitrary one of the two, which is how an expired
// credential ends up shadowing a valid login.
const DUMP_TWO_ACCOUNTS_ONE_SERVICE = `keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="default"
    "svce"<blob>="Claude Code-credentials"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Claude Code-credentials"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Claude Code-credentials-b9463664"
keychain: "/Users/u/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="alice"
    "svce"<blob>="Some Other Service"
`

test("parseKeychainDump: keeps both accounts sharing one service", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    const primary = refs.filter((r) => r.service === "Claude Code-credentials")
    assert.equal(primary.length, 2)
    assert.deepEqual(primary.map((r) => r.account).sort(), ["alice", "default"])
})

test("parseKeychainDump: pairs each account with its own service", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    const suffixed = refs.find((r) => r.service.endsWith("b9463664"))
    assert.ok(suffixed)
    assert.equal(suffixed.account, "alice")
})

test("parseKeychainDump: ignores unrelated services", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    assert.equal(
        refs.some((r) => r.service === "Some Other Service"),
        false,
    )
})

test("parseKeychainDump: orders the primary service first", () => {
    const refs = parseKeychainDump(DUMP_TWO_ACCOUNTS_ONE_SERVICE)
    assert.deepEqual(
        refs.slice(0, 2).map((r) => r.service),
        ["Claude Code-credentials", "Claude Code-credentials"],
    )
})

test("parseKeychainDump: returns nothing for an empty dump", () => {
    assert.deepEqual(parseKeychainDump(""), [])
})

test("encodeSource/decodeSource: round-trips a service+account pair", () => {
    const ref = { service: "Claude Code-credentials", account: "alice" }
    assert.deepEqual(decodeSource(encodeSource(ref)), ref)
})

test("decodeSource: a legacy service-only source stays account-less", () => {
    assert.deepEqual(decodeSource("Claude Code-credentials"), {
        service: "Claude Code-credentials",
    })
})

test("encodeSource: distinguishes accounts under the same service", () => {
    const a = encodeSource({
        service: "Claude Code-credentials",
        account: "default",
    })
    const b = encodeSource({
        service: "Claude Code-credentials",
        account: "alice",
    })
    assert.notEqual(a, b)
})
