import IDataStream, { type DataStreamState } from "./IDataStream";


/**
 * ブラウザ環境のネイティブなRTCDataChannelをラップした実装。
 */
export class BrowserDataStream implements IDataStream {
    private channel: RTCDataChannel;

    // IDataStreamインターフェースのプロパティ
    public get label(): string { return this.channel.label; }
    public get readyState(): DataStreamState {
        // RTCDataChannelStateをDataStreamStateにキャスト
        return this.channel.readyState as DataStreamState;
    }
    public get bufferedAmount(): number { return this.channel.bufferedAmount; }

    // IDataStreamインターフェースのイベントハンドラ
    public onopen: (() => void) | null = null;
    public onclose: (() => void) | null = null;
    public onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
    public onerror: ((event: Error) => void) | null = null;
    public onbufferedamountlow: (() => void) | null = null;

    constructor(channel: RTCDataChannel) {
        this.channel = channel;
        this.setupEventListeners();
    }

    private setupEventListeners(): void {
        this.channel.onopen = () => { if (this.onopen) this.onopen(); };
        this.channel.onclose = () => { if (this.onclose) this.onclose(); };
        this.channel.onmessage = (event) => {
            // TypeScriptの型システムに合わせるためにdataプロパティのみを持つオブジェクトを生成
            if (this.onmessage) this.onmessage({ data: event.data }); 
        };
        this.channel.onerror = (event) => { 
            // RTCErrorEventからErrorオブジェクトを生成して渡す
            if (this.onerror) this.onerror(new Error(event.error.message || 'RTCDataChannel Error')); 
        };
        this.channel.onbufferedamountlow = () => { if (this.onbufferedamountlow) this.onbufferedamountlow(); };
    }

    public send(data: ArrayBuffer): void {
        this.channel.send(data);
    }

    public close(): void {
        this.channel.close();
    }
}