// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
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
