import { loadNodeFs, loadNodePath } from './nodeFs.js';

/**
 * Node.js identity file storage (M4 / #36). PKCS#8 PEM is plaintext, therefore
 * files are created with 0600 and published atomically. On a creation race the
 * existing file wins and is returned for validation.
 */
export class NodeIdentityStorage {
    constructor(public readonly keyFile: string) {
        if (!keyFile) throw new Error('keyFile must not be empty');
    }

    public async load(): Promise<string | null> {
        const fs = await loadNodeFs();
        try {
            return await fs.readFile(this.keyFile, 'utf8');
        } catch (error) {
            if ((error as { code?: string }).code === 'ENOENT') return null;
            throw error;
        }
    }

    /** Save PEM without overwriting an existing identity; returns the winning PEM. */
    public async save(pem: string): Promise<string> {
        const fs = await loadNodeFs();
        const path = await loadNodePath();
        const dir = path.dirname(this.keyFile);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const temp = path.join(dir, `.${path.basename(this.keyFile)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
        try {
            await fs.writeFile(temp, pem, { flag: 'wx', mode: 0o600 });
            try {
                // hard link publishes the fully written temp atomically and never overwrites.
                await fs.link(temp, this.keyFile);
                await fs.chmod(this.keyFile, 0o600);
                return pem;
            } catch (error) {
                if ((error as { code?: string }).code === 'EEXIST') {
                    const existing = await this.load();
                    if (existing !== null) return existing;
                }
                throw error;
            }
        } finally {
            await fs.unlink(temp).catch(() => {});
        }
    }
}
