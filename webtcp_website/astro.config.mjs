// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeBaseLinks from './src/plugins/base-links.mjs';

// GitHub Pages のプロジェクトサイト（https://sonneko.github.io/WebTCP/）。
// `base` を変えるときは次も合わせる: src/content/docs/index.mdx の hero リンク（frontmatter のため自動では付かない）、
// examples/verify-static-demo.mjs の BASE、.github/workflows/deploy-pages.yml の配信先。
const SITE = 'https://sonneko.github.io';
const BASE = '/WebTCP';

// https://astro.build/config
export default defineConfig({
	site: SITE,
	base: BASE,
	markdown: {
		rehypePlugins: [[rehypeBaseLinks, { base: BASE }]],
	},
	integrations: [
		starlight({
			title: 'WebTCP',
			description: 'WebRTC データチャネル上に仮想 TCP/HTTP トンネルを構築する実験的 P2P ライブラリ',
			defaultLocale: 'root',
			locales: {
				root: {
					label: '日本語',
					lang: 'ja',
				},
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/sonneko/WebTCP',
				},
			],
			sidebar: [
				{
					label: 'はじめに',
					items: [
						{ label: 'クイックスタート', slug: 'guides/quickstart' },
						{ label: '名前解決と webtcp:// URL', slug: 'guides/name-resolution' },
						{ label: 'domain.global と所有権証明', slug: 'guides/domain-ownership' },
						{ label: 'HTTP トンネル（M6）', slug: 'guides/http-tunnel' },
						{ label: 'ブリッジ（curl からトンネルへ・M8）', slug: 'guides/bridge' },
						{ label: 'NAT 越えと STUN / TURN 設定', slug: 'guides/nat-turn-ice' },
						{ label: 'デモと実ブラウザ検証', slug: 'guides/demo-verification' },
					],
				},
				{
					label: 'アーキテクチャと仕様',
					items: [
						{ label: 'アーキテクチャ解説', slug: 'architecture/overview' },
						{ label: 'プロトコル仕様サマリー', slug: 'specification/protocol' },
					],
				},
				{
					label: 'リファレンス',
					items: [
						{ label: 'API リファレンス', slug: 'reference/api' },
						{ label: 'ロードマップと制約', slug: 'reference/roadmap' },
					],
				},
			],
		}),
	],
});
