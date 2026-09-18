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
