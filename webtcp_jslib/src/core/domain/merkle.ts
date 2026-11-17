/**
 * 領域分離付き Merkle 木と包含証明（specification.md §14.3）。
 *
 * - 葉: `H(0x00 || commitmentBytes)`
 * - 内部ノード: `H(0x01 || left || right)`
 * - ノード数が奇数のとき末尾は自分自身とペアにする（promote 規則）
 *
 * SHA-256 のみを使うため、ブラウザでも Node でも依存ゼロで検証できる。
 */

import { decodeBase64Url, encodeBase64Url } from '../routing/keys.js';
import { concatBytes, defaultDomainHash, prefixByte, type DomainHashFn } from './crypto.js';
import { domainCommitmentBytes } from './record.js';

/** 葉ノードのドメイン分離プレフィックス。 */
export const MERKLE_LEAF_PREFIX = 0x00;

/** 内部ノードのドメイン分離プレフィックス。 */
export const MERKLE_NODE_PREFIX = 0x01;

/**
 * ルートバインディングのプレフィックス。
 *
 * ルートを `H(0x02 || uint64BE(treeSize) || top)` として木サイズへバインドする
 * （RFC 6962 の title 相当）。これをしないと、ある木に対する包含証明が**別サイズの木**
 * でも成立してしまう（右端以外の葉では最上位の promote 有無しか差分が無い）。
 */
export const MERKLE_ROOT_PREFIX = 0x02;

/** 包含証明の最大深さ（2^32 葉に十分）。 */
export const MAX_MERKLE_PROOF_LENGTH = 32;

/** `treeSize` から期待される証明長を返す。 */
export function domainMerkleProofLength(treeSize: number): number {
    let length = 0;
    let count = treeSize;
    while (count > 1) {
        count = Math.ceil(count / 2);
        length += 1;
    }
    return length;
}

/** 葉ハッシュ `H(0x00 || commitmentBytes)`。 */
export async function domainMerkleLeafHash(
    commitmentBytes: Uint8Array,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<Uint8Array> {
    return hashFn(prefixByte(MERKLE_LEAF_PREFIX, commitmentBytes));
}

/** 内部ノードハッシュ `H(0x01 || left || right)`。 */
export async function domainMerkleNodeHash(
    left: Uint8Array,
    right: Uint8Array,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<Uint8Array> {
    return hashFn(prefixByte(MERKLE_NODE_PREFIX, concatBytes([left, right])));
}

/** 葉ハッシュの配列から根までの全レベルを計算する（内部用・テスタブル）。 */
export async function domainMerkleLevels(
    leafHashes: readonly Uint8Array[],
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<Uint8Array[][]> {
    if (leafHashes.length === 0) {
        throw new Error('Merkle tree requires at least one leaf');
    }
    const levels: Uint8Array[][] = [[...leafHashes]];
    let current = levels[0]!;
    while (current.length > 1) {
        const next: Uint8Array[] = [];
        for (let i = 0; i < current.length; i += 2) {
            const left = current[i]!;
            const right = current[i + 1] ?? left; // 奇数末尾は自分自身とペア（promote）
            next.push(await domainMerkleNodeHash(left, right, hashFn));
        }
        levels.push(next);
        current = next;
    }
    return levels;
}

/** 木サイズを顶层ハッシュへバインドしてルートにする（specification.md §14.3）。 */
export async function bindDomainMerkleRoot(
    top: Uint8Array,
    treeSize: number,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<Uint8Array> {
    const buffer = new Uint8Array(1 + 8 + top.byteLength);
    buffer[0] = MERKLE_ROOT_PREFIX;
    new DataView(buffer.buffer).setBigUint64(1, BigInt(treeSize), false);
    buffer.set(top, 9);
    return hashFn(buffer);
}

/** 葉の原料バイト列から、木サイズをバインドしたルート（生バイト）を計算する。 */
export async function computeDomainMerkleRoot(
    leafBytes: readonly Uint8Array[],
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<Uint8Array> {
    const hashes: Uint8Array[] = [];
    for (const leaf of leafBytes) hashes.push(await domainMerkleLeafHash(leaf, hashFn));
    const levels = await domainMerkleLevels(hashes, hashFn);
    return bindDomainMerkleRoot(levels[levels.length - 1]![0]!, leafBytes.length, hashFn);
}

/** チェックポイントの `root` に使う Base64url ルート（specification.md §15.4 の `buildDomainMerkleRoot`）。 */
export async function buildDomainMerkleRoot(
    leafBytes: readonly Uint8Array[],
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<string> {
    return encodeBase64Url(await computeDomainMerkleRoot(leafBytes, hashFn));
}

/** 指定葉の包含証明（兄弟ノードの Base64url、葉から根へ）を生成する。 */
export async function buildDomainMerkleProof(
    leafBytes: readonly Uint8Array[],
    leafIndex: number,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<string[]> {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafBytes.length) {
        throw new Error(`leaf index out of range: ${leafIndex}`);
    }
    const hashes: Uint8Array[] = [];
    for (const leaf of leafBytes) hashes.push(await domainMerkleLeafHash(leaf, hashFn));
    const levels = await domainMerkleLevels(hashes, hashFn);
    const proof: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level += 1) {
        const nodes = levels[level]!;
        const siblingIndex = index % 2 === 0 ? Math.min(index + 1, nodes.length - 1) : index - 1;
        const sibling = nodes[siblingIndex]!;
        proof.push(encodeBase64Url(sibling));
        index = Math.floor(index / 2);
    }
    return proof;
}

export interface VerifyDomainMerkleProofParams {
    /** `hex(SHA-256(canonical バイト列))`（specification.md §14.2 の commitment）。 */
    commitment: string;
    leafIndex: number;
    treeSize: number;
    /** Base64url の期待ルート。 */
    root: string;
    proof: readonly string[];
}

/**
 * 包含証明を検証する。`leafIndex < treeSize` と証明長の一致を必須とする（§14.3）。
 */
export async function verifyDomainMerkleProof(
    params: VerifyDomainMerkleProofParams,
    hashFn: DomainHashFn = defaultDomainHash,
): Promise<boolean> {
    const { commitment, leafIndex, treeSize, root, proof } = params;
    if (!Number.isSafeInteger(treeSize) || treeSize < 1) return false;
    let leafBytes: Uint8Array;
    try {
        leafBytes = domainCommitmentBytes(commitment);
    } catch {
        return false;
    }
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= treeSize) return false;
    const expectedLength = domainMerkleProofLength(treeSize);
    if (proof.length > MAX_MERKLE_PROOF_LENGTH) return false;
    if (proof.length !== expectedLength) return false;

    const expectedRoot = decodeBase64Url(root);
    if (!expectedRoot) return false;

    let current = await domainMerkleLeafHash(leafBytes, hashFn);
    let index = leafIndex;
    // 各レベルのノード数（奇数末尾は promote）を木サイズから再現し、証明の形状を検証する。
    let count = treeSize;
    for (let level = 0; level < proof.length; level += 1) {
        const sibling = decodeBase64Url(proof[level]!);
        if (!sibling) return false;
        const isPromoted = count % 2 === 1 && index === count - 1;
        if (isPromoted) {
            // promote 位置では兄弟が自分自身でなければならない（第二像防止）。
            if (!bytesEqual(sibling, current)) return false;
        } else if (sibling.byteLength !== 32) {
            return false;
        }
        const left = index % 2 === 0 ? current : sibling;
        const right = index % 2 === 0 ? sibling : current;
        current = await domainMerkleNodeHash(left, right, hashFn);
        index = Math.floor(index / 2);
        count = Math.ceil(count / 2);
    }
    if (index !== 0 || count !== 1) return false;
    const bound = await bindDomainMerkleRoot(current, treeSize, hashFn);
    return bytesEqual(bound, expectedRoot);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
    return true;
}
