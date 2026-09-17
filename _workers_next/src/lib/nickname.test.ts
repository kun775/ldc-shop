import test from 'node:test'
import assert from 'node:assert/strict'

const mod = await import(new URL('./nickname.ts', import.meta.url).href)
const { validateNickname } = mod

test('nickname validation trims valid names and counts Unicode characters', () => {
    assert.deepEqual(validateNickname('  小明  '), { ok: true, nickname: '小明' })
    assert.equal(validateNickname('😀😀').ok, true)
})

test('nickname validation rejects invalid values', () => {
    assert.deepEqual(validateNickname('  '), { ok: false, error: 'profile.nicknameRequired' })
    assert.deepEqual(validateNickname('a'), { ok: false, error: 'profile.nicknameTooShort' })
    assert.deepEqual(validateNickname('a'.repeat(33)), { ok: false, error: 'profile.nicknameTooLong' })
    assert.deepEqual(validateNickname('valid\nname'), { ok: false, error: 'profile.nicknameInvalid' })
})
