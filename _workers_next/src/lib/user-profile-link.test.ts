import test from 'node:test'
import assert from 'node:assert/strict'
import {
    getAdminUserProfileUrl,
    getDisplayUsername,
    getExternalProfileUrl,
    normalizeAdminUserProfileId,
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
    assert.equal(getAdminUserProfileUrl('github:583231'), '/admin/users/detail?userId=github%3A583231')
    assert.equal(getAdminUserProfileUrl('dex:ChABC123'), '/admin/users/detail?userId=dex%3AChABC123')
    assert.equal(getAdminUserProfileUrl(' 123 '), '/admin/users/detail?userId=123')
    assert.equal(getAdminUserProfileUrl('  '), null)
})

test('admin customer detail ids accept decoded and legacy encoded provider ids', () => {
    assert.equal(normalizeAdminUserProfileId('dex:ChABC123'), 'dex:ChABC123')
    assert.equal(normalizeAdminUserProfileId('dex%3AChABC123'), 'dex:ChABC123')
    assert.equal(normalizeAdminUserProfileId('dex%253AChABC123'), 'dex:ChABC123')
    assert.equal(normalizeAdminUserProfileId('github%3A583231'), 'github:583231')
    assert.equal(normalizeAdminUserProfileId('123'), '123')
    assert.equal(normalizeAdminUserProfileId('  '), null)
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
