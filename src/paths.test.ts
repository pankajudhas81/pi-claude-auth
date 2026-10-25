import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, test } from "node:test"
import { getAuthJsonPath, getPiAgentDir } from "./paths.ts"

const prev = process.env.PI_CODING_AGENT_DIR

afterEach(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prev
})

test("getPiAgentDir: defaults to ~/.pi/agent", () => {
    delete process.env.PI_CODING_AGENT_DIR
    assert.equal(getPiAgentDir(), join(homedir(), ".pi", "agent"))
})

test("getPiAgentDir: honors PI_CODING_AGENT_DIR override", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir"
    assert.equal(getPiAgentDir(), "/tmp/custom-pi-dir")
})

test("getAuthJsonPath: resolves under the agent dir", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-dir"
    assert.equal(getAuthJsonPath(), "/tmp/custom-pi-dir/auth.json")
})

test("getAuthJsonPath: matches the path pi locks for ~ and relative dirs", () => {
    // pi expands a leading ~ and proper-lockfile resolves the path; a
    // mismatch would make our lock exclude nobody.
    process.env.PI_CODING_AGENT_DIR = "~/custom-pi"
    assert.equal(getAuthJsonPath(), join(homedir(), "custom-pi", "auth.json"))
    process.env.PI_CODING_AGENT_DIR = "relative-pi"
    assert.equal(getAuthJsonPath(), resolve("relative-pi", "auth.json"))
})
