import { SequenceNumber } from '../types/protocol.js';

/** SACK オプション種別バイト（specification.md §8.4.4 / RFC 2018 準拠）。 */
export const SACK_OPTION_KIND = 0x05;

/** 1 つの ACK パケットに格納する最大 SACK ブロック数。 */
export const MAX_SACK_BLOCKS = 4;

/** 順序外で受信済みの連続バイト範囲 `[leftEdge, rightEdge)`（rightEdge は排他）。 */
export interface SackBlock {
    leftEdge: SequenceNumber;
    rightEdge: SequenceNumber;
}

/** シーケンス番号に正の増分を mod 2^32 で加算する。 */
export function seqAdd(seq: SequenceNumber, delta: number): SequenceNumber {
    return (seq + delta) >>> 0;
}

/**
 * 2 つの 32 ビットシーケンス番号の符号付き差分 `a - b`（RFC 1982 シリアル番号算術）。
 * 距離が 2^31 未満であればラップアラウンドをまたいでも正確に符号が定まる。
 */
export function seqDiff(a: SequenceNumber, b: SequenceNumber): number {
    return (a - b) | 0;
}

/** `a < b`（mod 2^32）。 */
export function seqLt(a: SequenceNumber, b: SequenceNumber): boolean {
    return seqDiff(a, b) < 0;
}

/** `a <= b`（mod 2^32）。 */
export function seqLte(a: SequenceNumber, b: SequenceNumber): boolean {
    return seqDiff(a, b) <= 0;
}

/** `a > b`（mod 2^32）。 */
export function seqGt(a: SequenceNumber, b: SequenceNumber): boolean {
    return seqDiff(a, b) > 0;
}

/** `a >= b`（mod 2^32）。 */
export function seqGte(a: SequenceNumber, b: SequenceNumber): boolean {
    return seqDiff(a, b) >= 0;
}

/**
 * 32 ビットのランダムな初期シーケンス番号（ISN）を生成する（specification.md §8.3.1）。
 */
export function generateInitialSeqNum(): SequenceNumber {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        cryptoObj.getRandomValues(buf);
        return buf[0]! >>> 0;
    }
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * SACK ブロック配列を ACK ペイロード用バイナリへエンコードする（specification.md §8.4.4）。
 * 空配列の場合は長さ 0 の `Uint8Array` を返す。
 */
export function encodeSackBlocks(blocks: readonly SackBlock[]): Uint8Array {
    const count = Math.min(blocks.length, MAX_SACK_BLOCKS);
    if (count === 0) return new Uint8Array(0);

    const buffer = new Uint8Array(2 + count * 8);
    const view = new DataView(buffer.buffer);
    view.setUint8(0, SACK_OPTION_KIND);
    view.setUint8(1, count);

    for (let i = 0; i < count; i += 1) {
        const block = blocks[i]!;
        const offset = 2 + i * 8;
        view.setUint32(offset, block.leftEdge >>> 0, false);
        view.setUint32(offset + 4, block.rightEdge >>> 0, false);
    }

    return buffer;
}

/**
 * ACK パケットのペイロードから SACK ブロック配列を復元する。
 * 空ペイロードや未知形式の場合は空配列を返す（後方互換性）。
 */
export function decodeSackBlocks(payload: Uint8Array): SackBlock[] {
    if (payload.byteLength < 2) return [];
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const kind = view.getUint8(0);
    if (kind !== SACK_OPTION_KIND) return [];

    const count = view.getUint8(1);
    if (count === 0 || count > MAX_SACK_BLOCKS) return [];
    if (payload.byteLength !== 2 + count * 8) return [];

    const blocks: SackBlock[] = [];
    for (let i = 0; i < count; i += 1) {
        const offset = 2 + i * 8;
        const leftEdge = view.getUint32(offset, false);
        const rightEdge = view.getUint32(offset + 4, false);
        if (seqGt(rightEdge, leftEdge)) {
            blocks.push({ leftEdge, rightEdge });
        }
    }
    return blocks;
}
