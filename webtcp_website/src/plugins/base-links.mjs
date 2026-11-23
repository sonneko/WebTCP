/**
 * ルート相対リンク（`/guides/...`）の先頭に `base`（例: `/WebTCP`）を付ける rehype プラグイン。
 *
 * Astro は Markdown 内のリンクへ base を自動で付けない。GitHub Pages のプロジェクトサイト
 * （`https://<user>.github.io/<repo>/`）はサブパスで配信されるため、内部リンクが壊れないように補う。
 * 外部 URL・プロトコル相対 URL・既に base を含むリンクは変更しない。
 */
export default function rehypeBaseLinks(options = {}) {
    const base = String(options.base ?? '').replace(/\/+$/, '');
    return (tree) => {
        if (!base) return;
        const visit = (node) => {
            if (
                node.type === 'element' &&
                node.tagName === 'a' &&
                node.properties &&
                typeof node.properties.href === 'string'
            ) {
                const href = node.properties.href;
                const isRootRelative = href.startsWith('/') && !href.startsWith('//');
                const alreadyPrefixed = href === base || href.startsWith(`${base}/`);
                if (isRootRelative && !alreadyPrefixed) node.properties.href = `${base}${href}`;
            }
            if (Array.isArray(node.children)) node.children.forEach(visit);
        };
        visit(tree);
    };
}
