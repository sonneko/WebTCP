/**
 * `HTTPRouter`（specification.md §16.3、任意の補助）。
 *
 * `router.add('GET', '/users/:id', handler)` のようにパターンを登録する。
 * パターンは `/` 区切りのセグメントで、`:name` は 1 セグメントにマッチし、
 * パラメータは `request.params` に入る（`HTTPRequest` の拡張）。
 * 最後のセグメントが `*` の場合は残りすべてにマッチする。
 */

import type { HTTPHandler, HTTPRequest, HTTPResponseWriter } from './message.js';

/** `HTTPRouter` がハンドラへ渡すリクエスト（パスパラメータ付き）。 */
export interface HTTPRoutedRequest extends HTTPRequest {
    readonly params: Readonly<Record<string, string>>;
}

export type HTTPRoutedHandler = (
    request: HTTPRoutedRequest,
    response: HTTPResponseWriter,
) => void | Promise<void>;

interface Route {
    method: string;
    segments: string[];
    handler: HTTPRoutedHandler;
}

/** メソッド + パスの簡易ディスパッチャ。 */
export class HTTPRouter {
    private readonly routes: Route[] = [];
    private notFound: HTTPHandler | null = null;
    private methodNotAllowed: HTTPHandler | null = null;

    /** ルートを登録する。`method` は大文字に正規化される。 */
    public add(method: string, pattern: string, handler: HTTPRoutedHandler): this {
        if (typeof handler !== 'function') throw new TypeError('HTTPRouter.add requires a handler');
        if (!pattern.startsWith('/')) throw new TypeError(`route pattern must start with '/' (got ${pattern})`);
        this.routes.push({
            method: method.toUpperCase(),
            segments: splitSegments(pattern),
            handler,
        });
        return this;
    }

    public get(pattern: string, handler: HTTPRoutedHandler): this {
        return this.add('GET', pattern, handler);
    }

    public post(pattern: string, handler: HTTPRoutedHandler): this {
        return this.add('POST', pattern, handler);
    }

    public put(pattern: string, handler: HTTPRoutedHandler): this {
        return this.add('PUT', pattern, handler);
    }

    public delete(pattern: string, handler: HTTPRoutedHandler): this {
        return this.add('DELETE', pattern, handler);
    }

    /** 404 のハンドラ（未指定なら `404 Not Found` のプレーンテキスト）。 */
    public setNotFound(handler: HTTPHandler): this {
        this.notFound = handler;
        return this;
    }

    /** 405 のハンドラ（未指定なら `405 Method Not Allowed`）。 */
    public setMethodNotAllowed(handler: HTTPHandler): this {
        this.methodNotAllowed = handler;
        return this;
    }

    /** `HTTPServer` にそのまま渡せるハンドラ。 */
    public readonly handle: HTTPHandler = async (request, response) => {
        const path = splitSegments(request.path);
        let pathMatched = false;
        for (const route of this.routes) {
            const params = matchSegments(route.segments, path);
            if (!params) continue;
            pathMatched = true;
            if (route.method !== request.method) continue;
            const routed: HTTPRoutedRequest = Object.assign(Object.create(request) as HTTPRequest, request, {
                params,
            });
            await route.handler(routed, response);
            return;
        }
        if (pathMatched) {
            if (this.methodNotAllowed) return this.methodNotAllowed(request, response);
            response.statusCode = 405;
            response.setHeader('content-type', 'text/plain; charset=utf-8');
            await response.end('method not allowed');
            return;
        }
        if (this.notFound) return this.notFound(request, response);
        response.statusCode = 404;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        await response.end('not found');
    };
}

function splitSegments(path: string): string[] {
    const withoutQuery = path.split('?')[0] ?? path;
    return withoutQuery.split('/').filter((segment, index) => index > 0 || segment.length > 0);
}

function matchSegments(pattern: string[], path: string[]): Record<string, string> | null {
    const params: Record<string, string> = {};
    for (let i = 0; i < pattern.length; i += 1) {
        const segment = pattern[i]!;
        if (segment === '*') {
            params['*'] = path.slice(i).join('/');
            return params;
        }
        const actual = path[i];
        if (actual === undefined) return null;
        if (segment.startsWith(':')) {
            if (actual.length === 0) return null;
            params[segment.slice(1)] = decodeURIComponentSafe(actual);
        } else if (segment !== actual) {
            return null;
        }
    }
    return pattern.length === path.length ? params : null;
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}
