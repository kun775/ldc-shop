import test from 'node:test'
import assert from 'node:assert/strict'
import {
    getAdminUserProfileUrl,
    getDisplayUsername,
    getExternalProfileUrl,
} from './user-profile-link.ts'

test('LinuxDo users link to their LinuxDo profile', () => {
    assert.equal(getExternalProfileUrl('alice', '123'), 'https://linux.do/u/alice')
    assert.equal(getDisplayUsername('alice', '123'), 'alice')
})

test('GitHub users link to GitHub and hide the internal username prefix', () => {
    assert.equal(getExternalProfileUrl('gh_OctoCat', 'github:583231'), 'https://github.com/octocat')
    assert.equal(getDisplayUsername('gh_OctoCat', 'github:583231'), 'gh_octocat')
})

test('admin customer links stay on the current shop origin', () => {
    assert.equal(getAdminUserProfileUrl('github:583231'), '/admin/users/github%3A583231')
    assert.equal(getAdminUserProfileUrl(' 123 '), '/admin/users/123')
    assert.equal(getAdminUserProfileUrl('  '), null)
})

test('DEX users never link out to LinuxDo', () => {
    assert.equal(getExternalProfileUrl('dex_alice', 'dex:ChABC123'), null)
    assert.equal(getDisplayUsername('dex_alice', 'dex:ChABC123'), 'dex_alice')
})

test('DEX identity is recognised from the user id alone and normalised on display', () => {
    assert.equal(getExternalProfileUrl('alice', 'dex:ChABC123'), null)
    assert.equal(getDisplayUsername('DEX_Alice', 'dex:ChABC123'), 'dex_alice')
    assert.equal(getDisplayUsername('Alice', 'dex:ChABC123'), 'dex_alice')
})

test('DEX user ids that are purely numeric are not mistaken for LinuxDo users', () => {
    assert.equal(getExternalProfileUrl('12345', 'dex:12345'), null)
    assert.equal(getExternalProfileUrl('12345', '12345'), 'https://linux.do/u/12345')
})
