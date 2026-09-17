export const NICKNAME_MIN_LENGTH = 2
export const NICKNAME_MAX_LENGTH = 32

export type NicknameValidationResult =
    | { ok: true; nickname: string }
    | { ok: false; error: 'profile.nicknameRequired' | 'profile.nicknameTooShort' | 'profile.nicknameTooLong' | 'profile.nicknameInvalid' }

export function validateNickname(input: unknown): NicknameValidationResult {
    const nickname = typeof input === 'string' ? input.trim() : ''
    if (!nickname) return { ok: false, error: 'profile.nicknameRequired' }
    if (/[\u0000-\u001F\u007F]/.test(nickname)) return { ok: false, error: 'profile.nicknameInvalid' }

    const length = Array.from(nickname).length
    if (length < NICKNAME_MIN_LENGTH) return { ok: false, error: 'profile.nicknameTooShort' }
    if (length > NICKNAME_MAX_LENGTH) return { ok: false, error: 'profile.nicknameTooLong' }
    return { ok: true, nickname }
}
