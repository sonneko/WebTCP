import { WebTCPPacket } from '../types/packet.js';
import { Milliseconds, SequenceNumber } from '../types/protocol.js';

/**
 * 再送キューに格納される、送信済みパケットのメタデータ。
 */
export interface QueuedPacket {
    packet: WebTCPPacket;
    sequenceNumber: SequenceNumber;
    /** 最後に送信した時刻（再送タイマーの基準）。 */
    sendTime: Milliseconds;
    /** 再送された回数。 */
    retransmissionCount: number;
}

export interface RetransmitQueueOptions {
    /** 再送タイムアウト（ms）。既定 1000。M2 で RTT から動的計算する。 */
    rtoMs?: Milliseconds;
}

/**
 * ACK 待ちパケットの管理と再送判定を行う。
 * 実際の再送は VirtualStream が行う。
 */
export class RetransmitQueue {
    private readonly queue = new Map<SequenceNumber, QueuedPacket>();
    private readonly rtoMs: Milliseconds;

    constructor(options: RetransmitQueueOptions = {}) {
        this.rtoMs = options.rtoMs ?? 1000;
    }

    /** 送信したパケットをキューに追加する。 */
    public enqueue(packet: WebTCPPacket, sequenceNumber: SequenceNumber): void {
        this.queue.set(sequenceNumber, {
            packet,
            sequenceNumber,
            sendTime: Date.now(),
            retransmissionCount: 0,
        });
    }

    /** 単一のシーケンス番号を削除する。 */
    public dequeue(sequenceNumber: SequenceNumber): boolean {
        return this.queue.delete(sequenceNumber);
    }

    /**
     * 累積 ACK を適用する。`ackNumber` 未満のシーケンス番号を削除する。
     */
    public dequeueCumulative(ackNumber: SequenceNumber): void {
        for (const sequenceNumber of [...this.queue.keys()]) {
            if (sequenceNumber < ackNumber) {
                this.queue.delete(sequenceNumber);
            }
        }
    }

    /** RTO を超えたパケットを返す。 */
    public getPacketsForRetransmission(): QueuedPacket[] {
        const now = Date.now();
        const result: QueuedPacket[] = [];
        for (const item of this.queue.values()) {
            if (now - item.sendTime > this.rtoMs) {
                result.push(item);
            }
        }
        return result;
    }

    /** 再送したパケットの送信時刻を更新し、回数を加算する。 */
    public markAsRetransmitted(sequenceNumber: SequenceNumber): void {
        const item = this.queue.get(sequenceNumber);
        if (item) {
            item.sendTime = Date.now();
            item.retransmissionCount += 1;
        }
    }

    /** キュー内のパケット数。 */
    public size(): number {
        return this.queue.size;
    }

    /** キューを空にする。 */
    public clear(): void {
        this.queue.clear();
    }
}
