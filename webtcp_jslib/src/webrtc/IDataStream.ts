// WebRTCのREADYSTATEを定義
export type DataStreamState = 'connecting' | 'open' | 'closing' | 'closed';

/**
 * WebRTC DataChannelの実装（ブラウザ/Node.js）を抽象化するインターフェース。
 */
export default interface IDataStream {
    // --- プロパティ (RTCDataChannelのプロパティを模倣) ---
    /** データチャネルの一意な名前 */
    readonly label: string;
    /** データチャネルの現在の状態 */
    readonly readyState: DataStreamState;
    /** 送信キュー内のデータ量（バイト） */
    readonly bufferedAmount: number;

    // --- イベントハンドラ (RTCDataChannelのイベントを模倣) ---
    /** 状態が 'open' になったときに発火 */
    onopen: (() => void) | null;
    /** 状態が 'closed' になったときに発火 */
    onclose: (() => void) | null;
    /** メッセージを受信したときに発火 */
    onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
    /** エラーが発生したときに発火 */
    onerror: ((event: Error) => void) | null;
    /** bufferedAmountがlowWaterMark以下になったときに発火 */
    onbufferedamountlow: (() => void) | null;

    // --- メソッド (RTCDataChannelのメソッドを模倣) ---
    /** データを送信する */
    send(data: string | ArrayBuffer): void;
    /** データチャネルを閉じる */
    close(): void;
}