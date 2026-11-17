/**
 * HTTP トンネル層（specification.md §15 / #50）。
 *
 * `VirtualStream` の上で HTTP/1.1 のサブセットを運ぶ。ワイヤー形式は変更しない。
 */

export {
    HTTPError,
    HTTPParseError,
    HTTPHeaderInjectionError,
    HTTPTimeoutError,
    HTTPResponseTooLargeError,
    HTTPConnectionClosedError,
    HTTPBodyConsumedError,
    HTTPAbortError,
} from './errors.js';
export {
    HTTPHeaders,
    HTTP_STATUS_TEXT,
    KNOWN_HTTP_METHODS,
    normalizeHeaderName,
    normalizeHeaderValue,
    splitTarget,
    statusTextFor,
} from './message.js';
export type {
    HTTPHandler,
    HTTPRequest,
    HTTPResponse,
    HTTPResponseWriter,
    HTTPBodyReader,
    HTTPResponseBody,
} from './message.js';
export {
    HTTPChunkedDecoder,
    HTTPHeadParser,
    declaredContentLength,
    determineRequestFraming,
    determineResponseFraming,
    findHeadEnd,
    parseHTTPHead,
    parseRequestLine,
    parseStatusLine,
    resolveParserLimits,
} from './parser.js';
export type {
    HTTPBodyFraming,
    HTTPHeadResult,
    HTTPParserLimits,
    ResolvedHTTPParserLimits,
} from './parser.js';
export { HTTPBodyStream } from './body.js';
export type { HTTPBodySource, HTTPBodyStreamOptions } from './body.js';
export { HTTPMessageReader } from './reader.js';
export type { HTTPMessageReaderOptions, HTTPStreamLike } from './reader.js';
export {
    connectionHasToken,
    encodeChunk,
    encodeChunkedEnd,
    serializeHTTPRequest,
    serializeHTTPResponse,
} from './writer.js';
export type { HTTPRequestWriteOptions, HTTPResponseWriteOptions } from './writer.js';
export { HTTPServer } from './server.js';
export type { HTTPServerNetwork, HTTPServerOptions } from './server.js';
export { HTTPClient } from './client.js';
export type {
    FetchURLOptions,
    HTTPClientBody,
    HTTPClientDirectRequest,
    HTTPClientNetwork,
    HTTPClientOptions,
    HTTPClientRequestOptions,
    HTTPClientUrlRequest,
} from './client.js';
export { HTTPRouter } from './router.js';
export type { HTTPRoutedHandler, HTTPRoutedRequest } from './router.js';
