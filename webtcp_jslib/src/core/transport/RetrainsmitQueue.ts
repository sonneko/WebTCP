import { WebTCPPacket } from '../types/packet';
import { SequenceNumber, Milliseconds } from '../types/protocol';

/**
 * 再送キューに格納される、送信済みパケットのメタデータ。
 */
interface QueuedPacket {
    packet: WebTCPPacket;         // 送信されたWebTCPPacket本体
    sequenceNumber: SequenceNumber; // パケットのシーケンス番号
    sendTime: Milliseconds;       // 最後に送信されたタイムスタンプ (再送タイマーに使用)
    retransmissionCount: number;  // 再送された回数
}

/**
 * WebTCPトランスポート層 (VirtualStream) において、
 * ACK待ちのパケットを管理し、再送処理をサポートするクラス。
 */
export class RetransmitQueue {
    // キー: シーケンス番号 (SequenceNumber)
    private queue: Map<SequenceNumber, QueuedPacket>;

    // 設定値
    // RTO (Retransmission Timeout) の初期値。実際のTCP/QUICでは動的に計算される。
    private initialRTO: Milliseconds = 3000; 

    constructor() {
        this.queue = new Map();
    }

    /**
     * 送信されたパケットをキューに追加する。
     * @param packet 送信されたWebTCPPacket。
     * @param sequenceNumber パケットのシーケンス番号。
     */
    public enqueue(packet: WebTCPPacket, sequenceNumber: SequenceNumber): void {
        const sendTime = Date.now();
        const queuedItem: QueuedPacket = {
            packet,
            sequenceNumber,
            sendTime,
            retransmissionCount: 0,
        };
        this.queue.set(sequenceNumber, queuedItem);
        // console.log(`[RQ] Enqueued SeqNum: ${sequenceNumber}. Queue size: ${this.queue.size}`);
    }

    /**
     * ACKが確認されたパケットをキューから削除する。
     * @param sequenceNumber ACKが確認されたパケットのシーケンス番号。
     * @returns 削除が成功した場合はtrue、存在しない場合はfalse。
     */
    public dequeue(sequenceNumber: SequenceNumber): boolean {
        const wasDeleted = this.queue.delete(sequenceNumber);
        // if (wasDeleted) {
        //     console.log(`[RQ] Dequeued SeqNum: ${sequenceNumber}. Remaining size: ${this.queue.size}`);
        // }
        return wasDeleted;
    }
    
    /**
     * 特定のシーケンス番号より前の全てのパケット（累積ACK）をキューから削除する。
     * @param ackNumber 確認応答された最新のシーケンス番号。
     */
    public dequeueCumulative(ackNumber: SequenceNumber): void {
        // SeqNumがackNumber未満のすべてのパケットを削除
        const keysToDelete: SequenceNumber[] = [];
        this.queue.forEach((item) => {
            // ACK numberは、次に期待するパケットの番号を意味することが多いため、
            // その手前のパケットまでを削除対象とする（TCPの一般的なセマンティクスに類似）。
            if (item.sequenceNumber < ackNumber) {
                keysToDelete.push(item.sequenceNumber);
            }
        });

        keysToDelete.forEach(seq => this.queue.delete(seq));
        // console.log(`[RQ] Dequeued ${keysToDelete.length} cumulative packets up to SeqNum ${ackNumber}.`);
    }

    /**
     * 再送が必要な（RTOが満了した）パケットのリストを取得する。
     * 実際に再送処理を行うのはVirtualStreamの責務となる。
     * @returns 再送が必要なQueuedPacketのリスト。
     */
    public getPacketsForRetransmission(): QueuedPacket[] {
        const now = Date.now();
        const packetsToRetransmit: QueuedPacket[] = [];

        this.queue.forEach((item) => {
            // 簡略化のため、RTOは初期値とする
            const rto = this.initialRTO; 
            
            if (now - item.sendTime > rto) {
                // 再送タイマーが満了
                packetsToRetransmit.push(item);
            }
        });
        
        return packetsToRetransmit;
    }

    /**
     * 再送処理が完了したパケットのメタデータを更新する。
     * (sendTimeをリセットし、再送回数をインクリメントする)
     * @param sequenceNumber 再送されたパケットのシーケンス番号。
     */
    public markAsRetransmitted(sequenceNumber: SequenceNumber): void {
        const item = this.queue.get(sequenceNumber);
        if (item) {
            item.sendTime = Date.now();
            item.retransmissionCount++;
            // console.log(`[RQ] Marked SeqNum ${sequenceNumber} as retransmitted. Count: ${item.retransmissionCount}`);
        }
    }

    /**
     * 現在キューにあるパケットの総数を取得する。
     * @returns キューのサイズ。
     */
    public size(): number {
        return this.queue.size;
    }
}
