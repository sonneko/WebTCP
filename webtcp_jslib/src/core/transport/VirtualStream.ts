import { EventEmitter } from 'events';
import { NodeId, VirtualPort, SequenceNumber, Milliseconds } from '../types/protocol';
import { WebTCPPacket } from '../types/packet';
import { RetransmitQueue } from './RetransmitQueue';

// TransportLayerへの参照インターフェース（パケットをRoutingLayerに渡す）
interface TransportLayer {
    sendPacket(packet: WebTCPPacket): Promise<void>;
    // ローカルノードIDはTransportLayerが保持していると仮定
    localNodeId: NodeId;
}

// ストリームの状態を定義 (TCPステートマシンを模倣)
export type StreamState = 'SYN_SENT' | 'SYN_RCVD' | 'ESTABLISHED' | 'FIN_WAIT_1' | 'FIN_WAIT_2' | 'CLOSED';

/**
 * WebTCPにおける単一の仮想TCPセッションを表すクラス。
 * 信頼性、順序保証、再送制御、ステートマシン管理を担う。
 */
export class VirtualStream extends EventEmitter {
    // セッション識別情報
    public sessionId: string;
    public remoteNodeId: NodeId;
    public remotePort: VirtualPort;
    public localPort: VirtualPort;
    public lastActivity: Milliseconds;

    // トランスポート状態
    public state: StreamState = 'CLOSED';

    // シーケンス番号管理
    private nextSendSeqNum: SequenceNumber = 0;   // 次に送信するパケットのSeqNum
    private expectedRecvSeqNum: SequenceNumber = 0; // 次に期待する受信パケットのSeqNum

    // フロー制御と信頼性
    private sendWindowSize: number = 10;        // 送信ウィンドウサイズ (簡易版)
    private unackedQueue: RetransmitQueue;      // ACK待ちパケットのキュー
    private pendingDataBuffer: WebTCPPacket[] = []; // 順序が乱れた受信データを保持

    // 依存オブジェクトとタイマー
    private transportLayer: TransportLayer;
    private retransmissionTimer: NodeJS.Timeout | null = null;
    private readonly RTO_CHECK_INTERVAL: Milliseconds = 1000; // 再送チェック周期

    constructor(
        transportLayer: TransportLayer,
        remoteNodeId: NodeId,
        localPort: VirtualPort,
        remotePort: VirtualPort,
        isInitiator: boolean // 接続を開始する側 (クライアント) かどうか
    ) {
        super();
        this.transportLayer = transportLayer;
        this.remoteNodeId = remoteNodeId;
        this.localPort = localPort;
        this.remotePort = remotePort;
        this.sessionId = `${remoteNodeId}:${localPort}:${remotePort}`;
        this.unackedQueue = new RetransmitQueue();
        this.lastActivity = Date.now();
        
        // 接続待ちの場合はSYN_RCVDから開始（SYNパケット受信後にこのインスタンスが生成されるため）
        if (!isInitiator) {
             this.state = 'SYN_RCVD';
        }

        this.startRetransmissionTimer();
    }
    
    // ===============================================
    // 接続確立・切断
    // ===============================================

    /**
     * 接続を開始し、SYNパケットを送信する。
     */
    public async initiateConnection(): Promise<void> {
        if (this.state !== 'CLOSED') return;
        
        const synPacket = this.createPacket('SYN', this.nextSendSeqNum, 'SYN request');
        await this.queueAndSendPacket(synPacket);
        
        this.state = 'SYN_SENT';
        this.nextSendSeqNum = (this.nextSendSeqNum + 1) as SequenceNumber; // SYN自体もSeqNumを消費
        console.log(`[VS:${this.localPort}] Initiating connection to ${this.remoteNodeId}. State: SYN_SENT.`);
    }

    /**
     * ストリームを閉じ、FINパケットを送信し、リソースを解放する。
     */
    public close(): void {
        if (this.state === 'CLOSED') return;

        // FINパケットを送信し、再送キューに入れる
        if (this.state === 'ESTABLISHED') {
            const finPacket = this.createPacket('FIN', this.nextSendSeqNum, 'FIN request');
            this.queueAndSendPacket(finPacket);
            this.state = 'FIN_WAIT_1';
            this.nextSendSeqNum = (this.nextSendSeqNum + 1) as SequenceNumber;
        }

        if (this.retransmissionTimer) {
            clearInterval(this.retransmissionTimer);
            this.retransmissionTimer = null;
        }
        console.log(`[VS:${this.localPort}] Stream closing. State: ${this.state}`);
        if (this.state === 'CLOSED') {
            this.emit('close');
        }
    }

    // ===============================================
    // 受信パケット処理 (メインハンドラ)
    // ===============================================

    /**
     * TransportLayerからパケットを受信し、ステートマシンに従って処理する。
     * @param packet 受信したWebTCPPacket。
     */
    public handleIncomingPacket(packet: WebTCPPacket): void {
        this.lastActivity = Date.now();
        
        // 簡略化のため、ここではパケットのペイロード内容でタイプを判定する（実際はフラグ）
        const type = this.getPacketType(packet);
        const seqNum = packet.seqNum as SequenceNumber;
        const ackNum = packet.ackNum as SequenceNumber;
        
        if (type === 'ACK' || type === 'SYN_ACK') {
            this.handleAck(ackNum);
        }
        
        if (type === 'SYN' || type === 'SYN_ACK') {
            this.handleSyn(packet);
        }

        if (type === 'DATA') {
            this.handleData(packet, seqNum);
        } else if (type === 'FIN') {
            this.handleFin(packet);
        } else if (type === 'RST') {
            this.handleRst();
        }
    }

    /**
     * パケットヘッダーの情報を基にタイプを判定する（ここではペイロードから仮定）。
     */
    private getPacketType(packet: WebTCPPacket): 'SYN' | 'ACK' | 'SYN_ACK' | 'DATA' | 'FIN' | 'RST' | 'OTHER' {
        const payloadStr = packet.payload.toString();
        if (payloadStr.includes('SYN-ACK')) return 'SYN_ACK';
        if (payloadStr.includes('SYN')) return 'SYN';
        if (payloadStr.includes('ACK')) return 'ACK';
        if (payloadStr.includes('FIN')) return 'FIN';
        if (payloadStr.includes('RST')) return 'RST';
        if (packet.payload.length > 0) return 'DATA';
        return 'OTHER';
    }

    private handleSyn(packet: WebTCPPacket): void {
        const remoteInitialSeqNum = packet.seqNum as SequenceNumber;
        this.expectedRecvSeqNum = (remoteInitialSeqNum + 1) as SequenceNumber;

        if (this.state === 'SYN_RCVD') {
            // 受動接続の応答: SYN-RCVD -> SYN-ACKを返す
            const synAck = this.createPacket('SYN_ACK', this.nextSendSeqNum, 'SYN-ACK response', this.expectedRecvSeqNum);
            this.queueAndSendPacket(synAck);
            this.nextSendSeqNum = (this.nextSendSeqNum + 1) as SequenceNumber;
            // 次のACKを受信したらESTABLISHEDに遷移
        } else if (this.state === 'SYN_SENT') {
            // 同時オープン or 衝突: SYN-ACKを返し、次のACKを待つ
            this.sendAck(this.expectedRecvSeqNum);
        }
    }

    private handleAck(ackNum: SequenceNumber): void {
        if (this.unackedQueue.size() === 0) return;

        // 1. 累積ACKに基づいてキューを更新
        this.unackedQueue.dequeueCumulative(ackNum);
        
        // 2. 接続状態の遷移
        if (this.state === 'SYN_SENT' && ackNum > 0) {
            this.state = 'ESTABLISHED';
            console.log(`[VS:${this.localPort}] Connection ESTABLISHED.`);
            this.emit('connect');
        } else if (this.state === 'FIN_WAIT_1') {
            // FINに対するACKを受信
            this.state = 'FIN_WAIT_2';
            console.log(`[VS:${this.localPort}] State: FIN_WAIT_2 (Waiting for remote FIN)`);
        }
        
        // 3. 送信ウィンドウの更新（ACKに含まれる情報に基づいて行うべきだが、ここでは省略）
    }

    private handleData(packet: WebTCPPacket, seqNum: SequenceNumber): void {
        if (this.state !== 'ESTABLISHED') return;

        if (seqNum === this.expectedRecvSeqNum) {
            // 期待通りのパケット
            this.emit('data', packet.payload.toString());
            this.expectedRecvSeqNum = (this.expectedRecvSeqNum + 1) as SequenceNumber;
            
            this.processPendingData(); // バッファリングされたデータを処理

            this.checkAndSendAck(); // ACKを返す
            
        } else if (seqNum > this.expectedRecvSeqNum) {
            // 順序が乱れている (Out-of-Order)
            this.pendingDataBuffer.push(packet);
            this.pendingDataBuffer.sort((a, b) => (a.seqNum as number) - (b.seqNum as number));
            console.warn(`[VS:${this.localPort}] Out-of-order packet. SeqNum: ${seqNum}. Expected: ${this.expectedRecvSeqNum}`);
            
            // 重複ACKを送信してロスしたパケットの再送を促すロジックをここに追加すべき
        }
    }
    
    private handleFin(packet: WebTCPPacket): void {
        if (this.state === 'ESTABLISHED' || this.state === 'FIN_WAIT_2') {
            // リモートからの切断要求
            this.expectedRecvSeqNum = (packet.seqNum as number + 1) as SequenceNumber;
            
            this.sendAck(this.expectedRecvSeqNum); // FINに対するACKを返す
            
            if (this.state === 'ESTABLISHED') {
                this.close(); // ローカルもFINを送信し、FIN_WAIT_1へ
            } else if (this.state === 'FIN_WAIT_2') {
                this.state = 'CLOSED'; 
                console.log(`[VS:${this.localPort}] Stream completely CLOSED (Passive).`);
                this.emit('close');
            }
        }
    }
    
    private handleRst(): void {
        this.state = 'CLOSED';
        console.error(`[VS:${this.localPort}] Connection reset by remote peer (RST received).`);
        this.emit('error', new Error('Connection reset (RST)'));
        this.close();
    }
    
    /**
     * バッファリングされたパケットをチェックし、順序通りになったものをアプリケーション層に渡す。
     */
    private processPendingData(): void {
        let processedCount = 0;
        while (this.pendingDataBuffer.length > 0 && 
               (this.pendingDataBuffer[0].seqNum as SequenceNumber) === this.expectedRecvSeqNum) {
            
            const packet = this.pendingDataBuffer.shift()!;
            this.emit('data', packet.payload.toString());
            this.expectedRecvSeqNum = (this.expectedRecvSeqNum + 1) as SequenceNumber;
            processedCount++;
        }
        if (processedCount > 0) {
            this.checkAndSendAck();
        }
    }

    // ===============================================
    // 送信処理と再送制御
    // ===============================================

    /**
     * アプリケーション層からデータを受け取り、パケット化して送信キューに入れる。
     */
    public async sendData(data: string): Promise<void> {
        if (this.state !== 'ESTABLISHED') {
            throw new Error(`Cannot send data. State is ${this.state}.`);
        }
        
        // フロー制御: ウィンドウが満杯ならエラー（実際には待機）
        if (this.unackedQueue.size() >= this.sendWindowSize) {
            throw new Error('Send window full');
        }

        const dataPacket = this.createPacket('DATA', this.nextSendSeqNum, data);
        await this.queueAndSendPacket(dataPacket);
        
        this.nextSendSeqNum = (this.nextSendSeqNum + 1) as SequenceNumber;
    }

    /**
     * 再送キューに追加し、TransportLayerに送信を依頼する。
     */
    private async queueAndSendPacket(
        packet: WebTCPPacket
    ): Promise<void> {
        // 再送が必要なパケットのみをキューに入れる
        const type = this.getPacketType(packet);
        if (type === 'SYN' || type === 'DATA' || type === 'FIN' || type === 'SYN_ACK') {
             this.unackedQueue.enqueue(packet, packet.seqNum as SequenceNumber);
        }
        
        // パケットをRoutingLayer経由で送信
        await this.transportLayer.sendPacket(packet);
        this.lastActivity = Date.now();
    }
    
    /**
     * パケットを作成するヘルパー関数。
     */
    private createPacket(
        type: 'SYN' | 'ACK' | 'SYN_ACK' | 'DATA' | 'FIN' | 'RST', 
        seqNum: SequenceNumber, 
        payload: string, 
        ackNum?: SequenceNumber
    ): WebTCPPacket {
        const flags = type; // 実際にはビットマスク
        return {
            senderId: this.transportLayer.localNodeId,
            destinationId: this.remoteNodeId,
            sourcePort: this.localPort,
            destinationPort: this.remotePort,
            ttl: 64, // デフォルトTTL
            flags: flags as any,
            seqNum: seqNum,
            ackNum: ackNum,
            payload: Buffer.from(payload),
            signature: '' // RoutingLayerで署名される
        } as WebTCPPacket;
    }

    /**
     * ACKパケットを作成し、送信する。
     */
    private sendAck(ackNum: SequenceNumber): void {
        const ackPacket = this.createPacket('ACK', this.nextSendSeqNum, '', ackNum);
        this.transportLayer.sendPacket(ackPacket); // ACKは信頼性が不要なためキューに入れない
    }
    
    /**
     * 受信データに基づいて累積ACKを送信する。
     */
    private checkAndSendAck(): void {
        // 次に期待するSeqNumをACK Numberとして送信
        this.sendAck(this.expectedRecvSeqNum);
    }
    
    // ===============================================
    // タイマー制御 (再送ループ)
    // ===============================================
    
    /**
     * RTOチェックのための定期タイマーを開始する。
     */
    private startRetransmissionTimer(): void {
        this.retransmissionTimer = setInterval(this.retransmissionLoop.bind(this), this.RTO_CHECK_INTERVAL);
    }

    /**
     * 再送制御のメインループ。タイムアウトしたパケットを再送する。
     */
    private retransmissionLoop(): void {
        const packetsToRetransmit = this.unackedQueue.getPacketsForRetransmission();

        if (packetsToRetransmit.length > 0) {
            console.warn(`[VS:${this.localPort}] Retransmitting ${packetsToRetransmit.length} packets due to RTO.`);
            
            packetsToRetransmit.forEach(async (queuedItem) => {
                // 最大再送回数チェック
                if (queuedItem.retransmissionCount >= 5) {
                    console.error(`[VS:${this.localPort}] Max retransmission count reached. Aborting connection.`);
                    // 相手にRSTを送り、状態をCLOSEDにする
                    this.state = 'CLOSED';
                    this.emit('error', new Error('Max retransmissions reached'));
                    this.close(); 
                    return;
                }

                // TransportLayer経由でパケットを再送
                await this.transportLayer.sendPacket(queuedItem.packet);
                
                // キューのメタデータを更新
                this.unackedQueue.markAsRetransmitted(queuedItem.sequenceNumber);
            });
        }
    }
}
