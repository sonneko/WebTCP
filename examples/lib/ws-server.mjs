/**
 * 最小の WebSocket サーバー（RFC 6455、サーバー側）。デモサーバーの参照実装用で、依存を増やさない。
 *
 * 対応範囲:
 * - Upgrade ハンドシェイク（`Sec-WebSocket-Key` → `Sec-WebSocket-Accept`）
 * - クライアントフレーム（マスク必須）の受信、断片化（continuation）の再構成
 * - テキストフレームの送信、ping / pong、close
 * - 最大ペイロード超過は 1009 で閉じる
 *
 * 対応しないもの: バイナリメッセージ（無視）、拡張（permessage-deflate）、サブプロトコル。
 */

import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** `Sec-WebSocket-Key` から `Sec-WebSocket-Accept` を作る。 */
export function webSocketAcceptKey(key) {
    return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
        header.writeUInt32BE(length >>> 0, 6);
    }
    return Buffer.concat([header, payload]);
}

/**
 * アップグレード済みのソケットを WebSocket として扱う。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ maxPayload?: number, pingIntervalMs?: number, onText: (text: string) => void, onClose?: () => void }} options
 * @returns {{ send: (text: string) => boolean, close: (code?: number) => void, isOpen: () => boolean }}
 */
export function acceptWebSocket(req, socket, head, options) {
    const maxPayload = options.maxPayload ?? 1 << 20;
    const key = req.headers['sec-websocket-key'];
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${webSocketAcceptKey(key)}\r\n` +
            '\r\n',
    );

    let open = true;
    let buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    /** @type {Buffer[] | null} 断片化されたテキストの途中経過 */
    let fragments = null;
    let fragmentBytes = 0;

    const finish = () => {
        if (!open) return;
        open = false;
        clearInterval(pingTimer);
        options.onClose?.();
    };

    const close = (code = 1000) => {
        if (!open) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(code, 0);
        socket.write(encodeFrame(OP_CLOSE, payload));
        open = false;
        clearInterval(pingTimer);
        socket.end();
        options.onClose?.();
    };

    const pingTimer = setInterval(() => {
        if (open) socket.write(encodeFrame(OP_PING));
    }, options.pingIntervalMs ?? 15_000);
    pingTimer.unref();

    const handleFrame = (opcode, fin, payload) => {
        if (opcode === OP_PING) {
            socket.write(encodeFrame(OP_PONG, payload));
            return;
        }
        if (opcode === OP_PONG || opcode === OP_BINARY) return;
        if (opcode === OP_CLOSE) {
            close(1000);
            return;
        }
        if (opcode === OP_TEXT) {
            if (fin) {
                options.onText(payload.toString('utf8'));
            } else {
                fragments = [payload];
                fragmentBytes = payload.length;
            }
            return;
        }
        if (opcode === OP_CONTINUATION && fragments) {
            fragments.push(payload);
            fragmentBytes += payload.length;
            if (fragmentBytes > maxPayload) {
                close(1009);
                return;
            }
            if (fin) {
                const text = Buffer.concat(fragments).toString('utf8');
                fragments = null;
                options.onText(text);
            }
        }
    };

    const parse = () => {
        while (open) {
            if (buffer.length < 2) return;
            const b0 = buffer[0];
            const b1 = buffer[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let length = b1 & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const high = buffer.readUInt32BE(2);
                const low = buffer.readUInt32BE(6);
                if (high > 0x1fffff) {
                    close(1009);
                    return;
                }
                length = high * 2 ** 32 + low;
                offset = 10;
            }

            if (!masked) {
                // クライアントのフレームは必ずマスクされる（RFC 6455 §5.1）
                close(1002);
                return;
            }
            if (length > maxPayload) {
                close(1009);
                return;
            }
            if (buffer.length < offset + 4 + length) return;

            const mask = buffer.subarray(offset, offset + 4);
            const payload = Buffer.alloc(length);
            for (let i = 0; i < length; i += 1) {
                payload[i] = buffer[offset + 4 + i] ^ mask[i % 4];
            }
            buffer = buffer.subarray(offset + 4 + length);
            handleFrame(opcode, fin, payload);
        }
    };

    socket.on('data', (chunk) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        parse();
    });
    // HTTP サーバーのソケットは allowHalfOpen のため、相手が FIN だけ送っても 'close' は来ない。
    // 'end' でも後始末し、購読が残らないようにする。
    socket.on('end', () => {
        finish();
        socket.end();
    });
    socket.on('close', finish);
    socket.on('error', finish);

    if (buffer.length > 0) parse();

    return {
        send(text) {
            if (!open || socket.destroyed) return false;
            socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
            return true;
        },
        close,
        isOpen: () => open,
    };
}
