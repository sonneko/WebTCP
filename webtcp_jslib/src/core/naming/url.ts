import { NODE_ID_PATTERN, isValidNodeId } from '../routing/keys.js';
import { NodeId, VirtualPort } from '../types/protocol.js';

/** Parsed `webtcp://` URL (specification.md §12.3). Port is mandatory. */
export interface WebTCPUrl {
    /** Normalized host: a NodeId literal or a registered name. */
    host: string;
    /** Present when host is a 32-character lowercase hex NodeId. */
    nodeId?: NodeId;
    /** Present when host is a name resolved through NameServer. */
    name?: string;
    port: VirtualPort;
    /** Path begins with `/`; defaults to `/`. */
    path: string;
    /** Includes the leading `?`, or empty. */
    search: string;
    /** Includes the leading `#`, or empty. */
    hash: string;
}

const URL_PATTERN = /^webtcp:\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
const NAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Normalize and validate a NameServer name (LDH labels, no NodeId literals). */
export function normalizeWebTCPName(value: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error('WebTCP name must not be empty');
    }
    let name = value.toLowerCase();
    if (name.endsWith('.')) name = name.slice(0, -1);
    if (name.length === 0 || name.length > 253) {
        throw new Error(`WebTCP name must be 1..253 characters (got ${name.length})`);
    }
    if (NODE_ID_PATTERN.test(name)) {
        throw new Error('NodeId literals are reserved and cannot be registered as names');
    }
    for (const label of name.split('.')) {
        if (!NAME_LABEL.test(label)) {
            throw new Error(`invalid WebTCP name label: ${label || '(empty)'}`);
        }
    }
    return name;
}

/**
 * Parse `webtcp://host:port/path?query#fragment` without relying on the
 * browser URL parser's non-special-scheme host/port behavior.
 */
export function parseWebTCPUrl(input: string): WebTCPUrl {
    if (typeof input !== 'string' || input.length === 0) {
        throw new Error('WebTCP URL must not be empty');
    }
    if (/[\s\x00-\x1f\x7f]/.test(input) || input.includes('\\')) {
        throw new Error('WebTCP URL must not contain whitespace, control characters or backslashes');
    }
    const match = URL_PATTERN.exec(input);
    if (!match) throw new Error('invalid WebTCP URL; expected webtcp://host:port/path');
    const authority = match[1]!;
    if (authority.length === 0 || authority.includes('@') || authority.includes('%')) {
        throw new Error('WebTCP URL authority must be host:port without userinfo or percent-encoding');
    }
    const colon = authority.lastIndexOf(':');
    if (colon <= 0 || colon === authority.length - 1 || authority.indexOf(':') !== colon) {
        throw new Error('WebTCP URL requires exactly one host:port separator');
    }
    const rawHost = authority.slice(0, colon).toLowerCase();
    const rawPort = authority.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(rawPort)) throw new Error(`invalid WebTCP port: ${rawPort}`);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`invalid WebTCP port: ${rawPort}`);
    }
    const path = match[2] || '/';
    if (!path.startsWith('/')) throw new Error('WebTCP URL path must begin with /');
    const base = { port, path, search: match[3] ?? '', hash: match[4] ?? '' };
    if (isValidNodeId(rawHost)) return { host: rawHost, nodeId: rawHost, ...base };
    const name = normalizeWebTCPName(rawHost);
    return { host: name, name, ...base };
}

/** Format a parsed URL into its canonical string form. */
export function formatWebTCPUrl(url: WebTCPUrl): string {
    return `webtcp://${url.host}:${url.port}${url.path}${url.search}${url.hash}`;
}
