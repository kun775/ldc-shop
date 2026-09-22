import test from "node:test"
import assert from "node:assert/strict"

const identity = await import(new URL("./github-identity.ts", import.meta.url).href)
const {
    canonicalGitHubUserId,
    githubProviderAccountId,
    isSameGitHubAccount,
    parseGitHubIdentity,
} = identity

test("github identity keeps the immutable numeric account id", () => {
    assert.equal(githubProviderAccountId("github:12345"), "12345")
    assert.equal(githubProviderAccountId("  12345  "), "12345")
    assert.equal(canonicalGitHubUserId("github:github:12345"), "github:12345")
    assert.deepEqual(parseGitHubIdentity("12345"), {
        provider: "github",
        providerAccountId: "12345",
        userId: "github:12345",
    })
})

test("github identity rejects ids that are not a stable numeric account", () => {
    for (const value of [null, "", "github:", "github:undefined", "github:null", "gh_alice", "alice"]) {
        assert.equal(canonicalGitHubUserId(value), null)
        assert.equal(parseGitHubIdentity(value), null)
    }
})

test("same github account allows only the legacy bare id and its canonical form", () => {
    assert.equal(isSameGitHubAccount("12345", "github:12345"), true)
    assert.equal(isSameGitHubAccount("github:12345", "github:12345"), true)
    assert.equal(isSameGitHubAccount("github:github:12345", "12345"), true)
})

test("different github accounts are never merged, even when one id is bare", () => {
    assert.equal(isSameGitHubAccount("github:12345", "github:67890"), false)
    assert.equal(isSameGitHubAccount("12345", "github:67890"), false)
    assert.equal(isSameGitHubAccount("67890", "github:12345"), false)
    assert.equal(isSameGitHubAccount("gh_alice", "github:12345"), false)
})
