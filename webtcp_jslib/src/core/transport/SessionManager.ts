import { NodeId, VirtualPort } from '../types/protocol';
import { WebTCPPacket } from '../types/packet';

/**
 * 仮想TCPセッション (VirtualStream) のインターフェース定義。
 * 実際には、./VirtualStream.ts でより詳細に実装される。
 */
export interface VirtualStream {
    sessionId: string;
    remoteNodeId: NodeId;
    remotePort: VirtualPort;
    localPort: VirtualPort;
    lastActivity: number;
    state: 'SYN_SENT' | 'ESTABLISHED' | 'FIN_WAIT' | 'CLOSED';

    handleIncomingPacket(packet: WebTCPPacket): void;
    close(): void;
}

/**
 * WebTCPトランスポート層における全ての仮想セッション (VirtualStream) の管理とライフサイクルを制御する。
 */
export class SessionManager {
    // キー: `${remoteNodeId}:${localPort}:${remotePort}`
    private activeStreams: Map<string, VirtualStream>;
    private cleanupInterval: NodeJS.Timeout | null = null;

    // 設定値
    private readonly SESSION_TIMEOUT_MS = 300000; // 5分間アクティビティがないセッションはタイムアウト
    private readonly CLEANUP_PERIOD_MS = 60000;  // 1分ごとにクリーンアップチェックを実行

    constructor() {
        this.activeStreams = new Map();
    }

    /**
     * セッションマネージャーの実行を開始し、定期的なクリーンアップをセットアップする。
     */
    public start(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cleanupInterval = setInterval(() => {
            this.runCleanup();
        }, this.CLEANUP_PERIOD_MS);
        console.log('[SM] Session Manager started.');
    }

    /**
     * セッションマネージャーを停止する。
     */
    public stop(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        console.log('[SM] Session Manager stopped.');
    }

    /**
     * セッションの一意なマップキーを生成する。
     */
    private generateKey(remoteNodeId: NodeId, localPort: VirtualPort, remotePort: VirtualPort): string {
        return `${remoteNodeId}:${localPort}:${remotePort}`;
    }

    /**
     * 新しい仮想ストリームを登録・追跡する。
     * @param stream 新しく確立されたVirtualStreamインスタンス。
     */
    public registerStream(stream: VirtualStream): void {
        const key = this.generateKey(stream.remoteNodeId, stream.localPort, stream.remotePort);
        if (this.activeStreams.has(key)) {
            console.warn(`[SM] Stream already exists for key: ${key}. Overwriting.`);
        }
        this.activeStreams.set(key, stream);
        console.log(`[SM] New stream registered. Total active: ${this.activeStreams.size}`);
    }

    /**
     * 既存のセッションを取得する。
     * @param remoteNodeId リモートノードID (パケット送信元)。
     * @param localPort パケットの宛先ポート。
     * @param remotePort パケットの送信元ポート。
     * @returns 該当するVirtualStreamインスタンス、またはnull。
     */
    public getStream(remoteNodeId: NodeId, localPort: VirtualPort, remotePort: VirtualPort): VirtualStream | undefined {
        const key = this.generateKey(remoteNodeId, localPort, remotePort);
        const stream = this.activeStreams.get(key);
        
        if (stream) {
            // アクティビティを更新
            stream.lastActivity = Date.now();
        }
        return stream;
    }

    /**
     * セッションを閉じ、リストから削除する。
     * @param remoteNodeId リモートノードID。
     * @param localPort ローカルポート。
     * @param remotePort リモートポート。
     */
    public closeAndDeregisterStream(remoteNodeId: NodeId, localPort: VirtualPort, remotePort: VirtualPort): void {
        const key = this.generateKey(remoteNodeId, localPort, remotePort);
        const stream = this.activeStreams.get(key);
        
        if (stream) {
            stream.close();
            this.activeStreams.delete(key);
            console.log(`[SM] Stream closed and deregistered for key: ${key}. Remaining: ${this.activeStreams.size}`);
        }
    }

    /**
     * 定期的に実行され、タイムアウトした非アクティブなセッションをクリーンアップする。
     */
    private runCleanup(): void {
        const now = Date.now();
        let cleanedUpCount = 0;

        this.activeStreams.forEach((stream, key) => {
            if (now - stream.lastActivity > this.SESSION_TIMEOUT_MS) {
                console.warn(`[SM] Stream ${key} timed out due to inactivity.`);
                stream.close(); // タイムアウト処理（RST送信など）
                this.activeStreams.delete(key);
                cleanedUpCount++;
            }
        });

        if (cleanedUpCount > 0) {
            console.log(`[SM] Cleanup complete. Removed ${cleanedUpCount} streams.`);
        }
    }
}
