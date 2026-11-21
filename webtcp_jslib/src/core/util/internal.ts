/**
 * コア内部で共有する小さな関数（公開 API ではない）。
 *
 * `core/util/index.ts` からは再エクスポートしない。公開名が必要な場合は、
 * 所属モジュール（例: `core/domain/crypto.ts` の `concatBytes`）で明示的に re-export する。
 */

/** 2 つのバイト列が同じ内容か（長さ・全バイトの一致）。 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** バイト列の配列を新しい 1 本の `Uint8Array` に連結する（常に新しいバッファを返す）。 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
    let length = 0;
    for (const part of parts) length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** 正の有限数であることを検査する。違反なら `name` を含む Error。 */
export function positive(value: number, name: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
    return value;
}

/** 正の整数であることを検査する。違反なら `name` を含む Error。 */
export function positiveInt(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
}
