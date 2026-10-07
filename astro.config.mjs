// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import remarkMinifichas, {
	flushMinifichaWarnings,
} from './src/lib/remark-minifichas.mjs';

// https://astro.build/config
export default defineConfig({
	site: 'https://artecompipoca.net',
	output: 'static',
	trailingSlash: 'always',
	build: {
		inlineStylesheets: 'always',
	},
	markdown: {
		processor: unified({ remarkPlugins: [remarkMinifichas] }),
	},
	integrations: [
		mdx(),
		sitemap(),
		{
			name: 'minificha-warnings',
			hooks: {
				'astro:build:done': () => {
					flushMinifichaWarnings();
				},
			},
		},
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
