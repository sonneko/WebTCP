import { WebTCPPacket } from '../types/packet.js';
import { Milliseconds, SequenceNumber } from '../types/protocol.js';
import { SackBlock, seqAdd, seqDiff, seqGte, seqLte } from './seq.js';

/**
 * 再送キューに格納される、送信済みセグメントのメタデータ。
 */
export interface QueuedPacket {
    packet: WebTCPPacket;
    /** セグメント先頭のバイトシーケンス番号。 */
    sequenceNumber: SequenceNumber;
    /** 消費するシーケンス空間の長さ（DATA: payload.byteLength, SYN/SYN_ACK/FIN: 1）。 */
    length: number;
    /** セグメント末尾の次シーケンス番号（`seqAdd(sequenceNumber, length)`）。 */
    endSeq: SequenceNumber;
    /** 初回送信時刻（Karn のアルゴリズムに基づく RTT 計測用）。 */
    firstSendTime: Milliseconds;
    /** 最後に送信した時刻（RTO 判定の基準）。 */
    sendTime: Milliseconds;
    /** 再送された回数。 */
    retransmissionCount: number;
    /** 相手から SACK により選択確認応答されたかどうか。 */
    sacked: boolean;
}

export interface RttEstimatorOptions {
    /** 初期 RTO（ms）。既定 1000。 */
    initialRtoMs?: Milliseconds;
    /** 最小 RTO（ms）。既定 200。 */
    minRtoMs?: Milliseconds;
    /** 最大 RTO（ms）。既定 60000。 */
    maxRtoMs?: Milliseconds;
    /** タイマー粒度 G（ms）。既定 50。 */
    clockGranularityMs?: Milliseconds;
}

/**
 * RFC 6298（Jacobson / Karn）に基づく動的 RTO 計算器（specification.md §8.4.1）。
 */
export class RttEstimator {
    private srtt: number | null = null;
    private rttvar: number | null = null;
    private rto: number;

    private readonly minRtoMs: number;
    private readonly maxRtoMs: number;
    private readonly clockGranularityMs: number;

    constructor(options: RttEstimatorOptions = {}) {
        this.minRtoMs = options.minRtoMs ?? 200;
        this.maxRtoMs = options.maxRtoMs ?? 60_000;
        this.clockGranularityMs = options.clockGranularityMs ?? 50;
        const initial = options.initialRtoMs ?? 1000;
        this.rto = this.clamp(initial);
    }

    /** 現在の RTO（ms）。 */
    public getRtoMs(): Milliseconds {
        return this.rto;
    }

    /** 現在の平滑化 RTT（未計測なら null）。 */
    public getSrttMs(): Milliseconds | null {
        return this.srtt;
    }

    /** 現在の RTT 分散推定値（未計測なら null）。 */
    public getRttvarMs(): Milliseconds | null {
        return this.rttvar;
    }

    /**
     * 再送されていないセグメントから得た RTT サンプル（ms）を反映する。
     */
    public recordSample(rttMs: Milliseconds): void {
        const sample = Math.max(1, rttMs);

        if (this.srtt === null || this.rttvar === null) {
            this.srtt = sample;
            this.rttvar = sample / 2;
        } else {
            // beta = 1/4, alpha = 1/8 (RFC 6298 §2.3)
            this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - sample);
            this.srtt = 0.875 * this.srtt + 0.125 * sample;
        }

        const candidate = this.srtt + Math.max(this.clockGranularityMs, 4 * this.rttvar);
        this.rto = this.clamp(Math.round(candidate));
    }

    /**
     * 再送タイムアウト発生時の指数バックオフ（RFC 6298 §5.5）。
     */
    public backoff(): void {
        this.rto = this.clamp(this.rto * 2);
    }

    private clamp(value: number): number {
        return Math.max(this.minRtoMs, Math.min(this.maxRtoMs, value));
    }
}

export interface RetransmitQueueOptions extends RttEstimatorOptions {
    /** 後方互換用: `initialRtoMs` の別名。 */
    rtoMs?: Milliseconds;
}

export interface CumulativeAckResult {
    /** 今回の ACK で新たに確認応答されたセグメント数。 */
    ackedSegments: number;
    /** 今回の ACK で新たに確認応答されたバイト数（DATA のみ + 制御長）。 */
    ackedBytes: number;
    /** Karn のアルゴリズムを満たす RTT サンプル（ms）。 */
    rttSamples: Milliseconds[];
}

/**
 * バイト範囲ベースの未 ACK セグメント管理・SACK・動的 RTO 判定を担う。
 * 実際の再送送信処理は `VirtualStream` が行う。
 */
export class RetransmitQueue {
    public readonly rttEstimator: RttEstimator;

    private readonly queue = new Map<SequenceNumber, QueuedPacket>();
    private totalInFlightBytes = 0;
    private totalSackedBytes = 0;

    constructor(options: RetransmitQueueOptions = {}) {
        const initialRtoMs = options.initialRtoMs ?? options.rtoMs ?? 1000;
        this.rttEstimator = new RttEstimator({
            initialRtoMs,
            ...(options.minRtoMs !== undefined ? { minRtoMs: options.minRtoMs } : {}),
            ...(options.maxRtoMs !== undefined ? { maxRtoMs: options.maxRtoMs } : {}),
            ...(options.clockGranularityMs !== undefined
                ? { clockGranularityMs: options.clockGranularityMs }
                : {}),
        });
    }

    /** 現在の動的 RTO（ms）。 */
    public getRtoMs(): Milliseconds {
        return this.rttEstimator.getRtoMs();
    }

    /** 送信したセグメントをキューに追加する。 */
    public enqueue(
        packet: WebTCPPacket,
        sequenceNumber: SequenceNumber,
        length?: number,
        now: Milliseconds = Date.now(),
    ): QueuedPacket {
        const segLen =
            length ??
            (packet.flags === 'DATA' ? packet.payload.byteLength : 1);
        const endSeq = seqAdd(sequenceNumber, segLen);

        const existing = this.queue.get(sequenceNumber);
        if (existing) {
            this.totalInFlightBytes -= existing.length;
            if (existing.sacked) {
                this.totalSackedBytes -= existing.length;
            }
        }

        const entry: QueuedPacket = {
            packet,
            sequenceNumber,
            length: segLen,
            endSeq,
            firstSendTime: now,
            sendTime: now,
            retransmissionCount: 0,
            sacked: false,
        };
        this.queue.set(sequenceNumber, entry);
        this.totalInFlightBytes += segLen;
        return entry;
    }

    /** 単一のシーケンス番号を削除する。 */
    public dequeue(sequenceNumber: SequenceNumber): boolean {
        const item = this.queue.get(sequenceNumber);
        if (!item) return false;
        this.queue.delete(sequenceNumber);
        this.totalInFlightBytes -= item.length;
        if (item.sacked) {
            this.totalSackedBytes -= item.length;
        }
        return true;
    }

    /**
     * 累積 ACK を適用し、`endSeq <= ackNumber` のセグメントを削除する（mod 2^32 対応）。
     * 再送されていないセグメントから RTT サンプルを収集して `rttEstimator` を更新する。
     */
    public dequeueCumulative(
        ackNumber: SequenceNumber,
        now: Milliseconds = Date.now(),
    ): CumulativeAckResult {
        let ackedSegments = 0;
        let ackedBytes = 0;
        const rttSamples: Milliseconds[] = [];

        for (const [seq, item] of [...this.queue.entries()]) {
            if (seqLte(item.endSeq, ackNumber)) {
                this.queue.delete(seq);
                this.totalInFlightBytes -= item.length;
                if (item.sacked) {
                    this.totalSackedBytes -= item.length;
                }
                ackedSegments += 1;
                ackedBytes += item.length;

                // Karn のアルゴリズム: 再送していないセグメントのみ RTT を計測する
                if (item.retransmissionCount === 0) {
                    const rtt = Math.max(1, now - item.firstSendTime);
                    rttSamples.push(rtt);
                    this.rttEstimator.recordSample(rtt);
                }
            }
        }

        return { ackedSegments, ackedBytes, rttSamples };
    }

    /**
     * 受信した SACK ブロックを適用し、完全に包含されるセグメントに `sacked = true` を設定する。
     * @returns 新たに SACK マークされたセグメント数
     */
    public applySackBlocks(blocks: readonly SackBlock[]): number {
        if (blocks.length === 0 || this.queue.size === 0) return 0;

        let newlySacked = 0;
        for (const item of this.queue.values()) {
            if (item.sacked) continue;
            for (const block of blocks) {
                if (seqGte(item.sequenceNumber, block.leftEdge) && seqLte(item.endSeq, block.rightEdge)) {
                    item.sacked = true;
                    this.totalSackedBytes += item.length;
                    newlySacked += 1;
                    break;
                }
            }
        }
        return newlySacked;
    }

    /** RTO タイムアウト時に SACK マークをクリアする（RFC 6675 §5.1）。 */
    public clearSackMarks(): void {
        for (const item of this.queue.values()) {
            item.sacked = false;
        }
        this.totalSackedBytes = 0;
    }

    /** 最も古い未確認セグメントの開始シーケンス番号（空なら null）。 */
    public getOldestSeq(): SequenceNumber | null {
        const oldest = this.getOldestPacket();
        return oldest ? oldest.sequenceNumber : null;
    }

    /** 最も古い未確認セグメント（空なら null）。 */
    public getOldestPacket(): QueuedPacket | null {
        let oldest: QueuedPacket | null = null;
        for (const item of this.queue.values()) {
            if (!oldest || seqDiff(item.sequenceNumber, oldest.sequenceNumber) < 0) {
                oldest = item;
            }
        }
        return oldest;
    }

    /**
     * SACK されていない最古の未確認セグメントを返す（Fast Retransmit 対象）。
     */
    public getOldestUnsackedPacket(): QueuedPacket | null {
        let oldest: QueuedPacket | null = null;
        for (const item of this.queue.values()) {
            if (item.sacked) continue;
            if (!oldest || seqDiff(item.sequenceNumber, oldest.sequenceNumber) < 0) {
                oldest = item;
            }
        }
        return oldest;
    }

    /**
     * Fast Recovery 中に再送候補となる未 SACK セグメントを順序通りに返す。
     */
    public getUnsackedPackets(): QueuedPacket[] {
        const result: QueuedPacket[] = [];
        for (const item of this.queue.values()) {
            if (!item.sacked) {
                result.push(item);
            }
        }
        result.sort((a, b) => seqDiff(a.sequenceNumber, b.sequenceNumber));
        return result;
    }

    /** RTO を超えた未 SACK セグメントを古い順に返す。 */
    public getPacketsForRetransmission(now: Milliseconds = Date.now()): QueuedPacket[] {
        const rtoMs = this.rttEstimator.getRtoMs();
        const result: QueuedPacket[] = [];
        for (const item of this.queue.values()) {
            if (item.sacked) continue;
            if (now - item.sendTime >= rtoMs) {
                result.push(item);
            }
        }
        result.sort((a, b) => seqDiff(a.sequenceNumber, b.sequenceNumber));
        return result;
    }

    /** 再送したセグメントの送信時刻を更新し、回数を加算する。 */
    public markAsRetransmitted(
        sequenceNumber: SequenceNumber,
        now: Milliseconds = Date.now(),
    ): void {
        const item = this.queue.get(sequenceNumber);
        if (item) {
            item.sendTime = now;
            item.retransmissionCount += 1;
        }
    }

    /** 未 ACK の総バイト数。 */
    public getInFlightBytes(): number {
        return Math.max(0, this.totalInFlightBytes);
    }

    /** SACK 済みを除いた実効 in-flight バイト数（pipe 推定）。 */
    public getEffectiveInFlightBytes(): number {
        return Math.max(0, this.totalInFlightBytes - this.totalSackedBytes);
    }

    /** キュー内のセグメント数。 */
    public size(): number {
        return this.queue.size;
    }

    /** キューを空にする。 */
    public clear(): void {
        this.queue.clear();
        this.totalInFlightBytes = 0;
        this.totalSackedBytes = 0;
    }
}
