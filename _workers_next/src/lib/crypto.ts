import { createHash, randomUUID } from "crypto";

export function md5(message: string): string {
    return createHash('md5').update(message).digest('hex');
}

export function generateSign(params: Record<string, any>, key: string): string {
    const sorted = Object.keys(params)
        .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== null && params[k] !== undefined)
        .sort()
        .map(k => `${k}=${params[k]}`)
        .join('&');

    return md5(`${sorted}${key}`);
}

export function generateOrderId(): string {
    return `ORD${randomUUID().replaceAll('-', '').toUpperCase()}`;
}
