#!/usr/bin/env node
/**
 * 公開デモ用に `examples/demo` と `webtcp_jslib/dist` を `public/` へ複製する。
 *
 * 配置はローカルのデモサーバー（`examples/server.mjs`）と同じ（`/examples/demo/`、`/webtcp_jslib/dist/`）。
 * そのため `demo.js` の `import '../../webtcp_jslib/dist/index.js'` を変えずに、そのまま動く。
 * 生成物は Git 管理外（`.gitignore`）。`npm run build` の前に自動で実行される（`prebuild`）。
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..');

const demoFrom = join(repoRoot, 'examples', 'demo');
const demoTo = join(siteRoot, 'public', 'examples', 'demo');
const libFrom = join(repoRoot, 'webtcp_jslib', 'dist');
const libTo = join(siteRoot, 'public', 'webtcp_jslib', 'dist');

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

if (!(await exists(join(libFrom, 'index.js')))) {
    throw new Error(
        `webtcp_jslib/dist/index.js が無い。先に \`cd webtcp_jslib && npm ci && npm run build\` を実行してください`,
    );
}

await rm(join(siteRoot, 'public', 'examples'), { recursive: true, force: true });
await rm(join(siteRoot, 'public', 'webtcp_jslib'), { recursive: true, force: true });

await mkdir(demoTo, { recursive: true });
for (const name of await readdir(demoFrom)) {
    if (name.endsWith('.html') || name.endsWith('.js')) {
        await cp(join(demoFrom, name), join(demoTo, name));
    }
}
await cp(libFrom, libTo, { recursive: true });

console.log(`[sync-demo] ${demoFrom} -> ${demoTo}`);
console.log(`[sync-demo] ${libFrom} -> ${libTo}`);
