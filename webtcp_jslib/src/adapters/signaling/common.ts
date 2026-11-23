import { SignalMessage } from '../../core/link/ISignalingAdapter.js';
import { NodeId } from '../../core/types/protocol.js';

/** 受信のバックオフ（specification.md §10.4.1）。 */
export interface SignalingBackoffOptions {
    /** 初回の待ち時間（ms）。既定 500。 */
    initialMs?: number;
    /** 待ち時間の上限（ms）。既定 10000。 */
    maxMs?: number;
}

/** 末尾のスラッシュを取り除いた基底 URL。 */
export function normalizeHubUrl(url: string): string {
    if (!url) {
        throw new Error('signaling adapter requires a hub URL');
    }
    return url.replace(/\/+$/, '');
}

/** 試行回数に応じた待ち時間（指数バックオフ、上限あり）。 */
export function backoffDelay(attempt: number, options: SignalingBackoffOptions = {}): number {
    const initial = options.initialMs ?? 500;
    const max = options.maxMs ?? 10_000;
    return Math.min(max, initial * 2 ** Math.max(0, attempt));
}

/** `POST /signal` でメッセージを送る（ポーリング版と同じ本文）。2xx 以外は reject する。 */
export async function postSignal(
    fetchImpl: typeof fetch,
    baseUrl: string,
    fromId: NodeId,
    recipientId: NodeId,
    message: SignalMessage,
): Promise<void> {
    const response = await fetchImpl(`${baseUrl}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            fromId,
            toId: recipientId,
            message: { ...message, fromId },
        }),
    });
    if (!response.ok) {
        throw new Error(`Failed to send signaling message to ${recipientId}: HTTP ${response.status}`);
    }
}

/** 押し込み型の受信メッセージ（サーバーが付けた `id` を持つ）。 */
export interface StreamedSignal {
    id: number;
    fromId: NodeId;
    message: SignalMessage;
}

/** `id` が数値で、カーソルより新しい場合だけ通す（重複排除、specification.md §10.4.1）。 */
export function isNewerThanCursor(entry: Partial<StreamedSignal>, cursor: number): entry is StreamedSignal {
    return (
        typeof entry.id === 'number' &&
        Number.isFinite(entry.id) &&
        entry.id > cursor &&
        typeof entry.fromId === 'string' &&
        typeof entry.message === 'object' &&
        entry.message !== null
    );
}
