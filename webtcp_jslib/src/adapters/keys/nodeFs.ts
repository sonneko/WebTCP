/** Minimal structural types for dynamically imported Node filesystem APIs. */
export interface MinimalNodeFs {
    mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    writeFile(path: string, data: string, options: { flag: string; mode: number }): Promise<void>;
    link(existingPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
}
export interface MinimalNodePath {
    dirname(path: string): string;
    join(...paths: string[]): string;
    basename(path: string): string;
}

let fsPromise: Promise<MinimalNodeFs> | null = null;
let pathPromise: Promise<MinimalNodePath> | null = null;

export function loadNodeFs(): Promise<MinimalNodeFs> {
    if (!fsPromise) {
        const name = 'node:' + 'fs/promises';
        fsPromise = import(name).then((mod) => (mod.default ?? mod) as unknown as MinimalNodeFs);
    }
    return fsPromise;
}
export function loadNodePath(): Promise<MinimalNodePath> {
    if (!pathPromise) {
        const name = 'node:' + 'path';
        pathPromise = import(name).then((mod) => (mod.default ?? mod) as unknown as MinimalNodePath);
    }
    return pathPromise;
}
