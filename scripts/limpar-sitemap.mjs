#!/usr/bin/env node
/**
 * Pós-build: remove dos sitemaps em dist/ toda URL cuja página tenha
 * <meta name="robots"> com noindex. Imprime as URLs removidas.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** @param {string} loc */
function htmlDaUrl(loc) {
	const { pathname } = new URL(loc);
	const caminho = decodeURIComponent(pathname);
	return caminho.endsWith('/')
		? join(DIST, caminho, 'index.html')
		: join(DIST, caminho);
}

/** @param {string} html */
function temNoindex(html) {
	for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = m[0];
		if (!/name\s*=\s*["']robots["']/i.test(tag)) continue;
		const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
		if (/noindex/i.test(content)) return true;
	}
	return false;
}

async function main() {
	const arquivos = (await readdir(DIST)).filter(
		(f) => /^sitemap-.*\.xml$/.test(f) && f !== 'sitemap-index.xml',
	);
	if (arquivos.length === 0) {
		console.warn('limpar-sitemap: nenhum sitemap encontrado em dist/.');
		return;
	}

	/** @type {string[]} */
	const removidas = [];
	/** @type {string[]} */
	const semHtml = [];
	let mantidas = 0;

	for (const arquivo of arquivos) {
		const caminho = join(DIST, arquivo);
		const xml = await readFile(caminho, 'utf8');
		const blocos = [...xml.matchAll(/<url>[\s\S]*?<\/url>/g)];
		let novo = xml;
		for (const bloco of blocos) {
			const loc = bloco[0].match(/<loc>([^<]+)<\/loc>/)?.[1];
			if (!loc) continue;
			let html;
			try {
				html = await readFile(htmlDaUrl(loc), 'utf8');
			} catch {
				semHtml.push(loc);
				mantidas++;
				continue;
			}
			if (temNoindex(html)) {
				novo = novo.replace(bloco[0], '');
				removidas.push(loc);
			} else {
				mantidas++;
			}
		}
		if (novo !== xml) await writeFile(caminho, novo);
	}

	console.log(
		`limpar-sitemap: ${removidas.length} URL(s) noindex removida(s), ${mantidas} mantida(s).`,
	);
	for (const url of removidas) console.log(`  - ${url}`);
	if (semHtml.length) {
		console.warn(`limpar-sitemap: ${semHtml.length} URL(s) sem HTML correspondente (mantidas):`);
		for (const url of semHtml) console.warn(`  ? ${url}`);
	}
}

main().catch((err) => {
	console.error('limpar-sitemap falhou:', err);
	process.exitCode = 1;
});
