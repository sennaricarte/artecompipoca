#!/usr/bin/env node
/**
 * Gera os redirects permanentes das URLs antigas para o vercel.json.
 *
 * Fontes:
 *  - redirects-manuais.json (mantidos à mão, entram primeiro e têm prioridade);
 *  - frontmatter de src/content/{artigos,resenhas}: posts com draft: false e legacyUrl
 *    geram legacyUrl e /index.php{legacyUrl} → URL nova;
 *  - _recuperados/redirects-sugeridos.json: redirects de duplicatas (origem que não é
 *    legacyUrl de nenhum post), só quando o destino é um post publicado.
 *
 * Uso:
 *   node scripts/gerar-redirects.mjs          grava o vercel.json
 *   node scripts/gerar-redirects.mjs --check  compara; com VERCEL=1 falha se desatualizado
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const VERCEL_JSON = join(ROOT, 'vercel.json');
const MANUAIS_JSON = join(ROOT, 'redirects-manuais.json');
const SUGERIDOS_JSON = join(ROOT, '_recuperados', 'redirects-sugeridos.json');
const COLECOES = ['artigos', 'resenhas'];
const CHECK = process.argv.includes('--check');
const ON_VERCEL = process.env.VERCEL === '1';

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** @typedef {{ source: string, destination: string, permanent: boolean }} Redirect */

/** @param {string} path */
async function lerJson(path, padrao) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (err) {
		if (err.code === 'ENOENT') return padrao;
		throw err;
	}
}

/** @param {string} yaml @param {string} chave */
function campo(yaml, chave) {
	const valor = yaml.match(new RegExp(`^${chave}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim();
	if (valor == null || valor === '') return undefined;
	return valor.replace(/^(["'])(.*)\1$/, '$2');
}

/** Caracteres especiais do path-to-regexp usado pela Vercel em `source`. */
function escaparSource(path) {
	return path.replace(/([():*+?{}\\])/g, '\\$1');
}

/** Normaliza uma origem para comparação (sem /index.php, com barra final). */
function chaveLegacy(path) {
	let p = path.replace(/^\/index\.php(?=\/)/, '');
	if (!p.endsWith('/')) p += '/';
	return p;
}

async function lerPosts() {
	const posts = [];
	for (const colecao of COLECOES) {
		const dir = join(ROOT, 'src', 'content', colecao);
		for (const nome of await readdir(dir)) {
			if (!/\.mdx?$/.test(nome)) continue;
			const bruto = await readFile(join(dir, nome), 'utf8');
			const yaml = bruto.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
			const id = basename(nome, extname(nome));
			const editoria = campo(yaml, 'editoria');
			posts.push({
				colecao,
				id,
				publicado: campo(yaml, 'draft') === 'false',
				legacyUrl: campo(yaml, 'legacyUrl'),
				url: colecao === 'resenhas' ? `/resenhas/${id}/` : `/${editoria}/${id}/`,
			});
		}
	}
	return posts;
}

async function calcular() {
	const posts = await lerPosts();
	const publicados = posts.filter((p) => p.publicado);
	const urlsPublicadas = new Set(publicados.map((p) => p.url));
	const legaciesDePosts = new Set(
		posts.filter((p) => p.legacyUrl).map((p) => chaveLegacy(p.legacyUrl)),
	);

	/** @type {Redirect[]} */
	const doConteudo = [];
	for (const p of publicados) {
		if (!p.legacyUrl) continue;
		if (chaveLegacy(p.legacyUrl) === p.url) continue;
		for (const origem of [p.legacyUrl, `/index.php${p.legacyUrl}`]) {
			doConteudo.push({ source: origem, destination: p.url, permanent: true });
		}
	}

	const sugeridos = /** @type {Redirect[]} */ (await lerJson(SUGERIDOS_JSON, []));
	/** @type {Redirect[]} */
	const deDuplicatas = [];
	let duplicatasIgnoradas = 0;
	for (const r of sugeridos) {
		if (legaciesDePosts.has(chaveLegacy(r.source))) continue;
		if (!urlsPublicadas.has(r.destination)) {
			duplicatasIgnoradas++;
			continue;
		}
		deDuplicatas.push({ source: r.source, destination: r.destination, permanent: true });
	}

	const manuais = /** @type {Redirect[]} */ (await lerJson(MANUAIS_JSON, []));

	/** @type {Map<string, Redirect>} */
	const porSource = new Map();
	const conflitos = [];
	for (const r of manuais) porSource.set(r.source, r);
	const gerados = [...doConteudo, ...deDuplicatas].map((r) => ({
		...r,
		source: escaparSource(r.source),
	}));
	gerados.sort((a, b) => a.source.localeCompare(b.source));
	for (const r of gerados) {
		if (urlsPublicadas.has(chaveLegacy(r.source))) {
			conflitos.push(`${r.source} é uma URL nova publicada; ignorado`);
			continue;
		}
		const existente = porSource.get(r.source);
		if (existente) {
			if (existente.destination !== r.destination) {
				conflitos.push(`${r.source}: mantido ${existente.destination}, ignorado ${r.destination}`);
			}
			continue;
		}
		porSource.set(r.source, r);
	}

	return {
		redirects: [...porSource.values()],
		stats: {
			manuais: manuais.length,
			doConteudo: doConteudo.length,
			deDuplicatas: deDuplicatas.length,
			duplicatasIgnoradas,
			postsPublicados: publicados.length,
		},
		conflitos,
	};
}

async function main() {
	const { redirects, stats, conflitos } = await calcular();
	const vercel = await lerJson(VERCEL_JSON, {});
	const atual = JSON.stringify(vercel.redirects ?? []);
	const esperado = JSON.stringify(redirects);

	if (CHECK) {
		if (atual === esperado) {
			console.log(`gerar-redirects: vercel.json em dia (${redirects.length} redirects).`);
			return;
		}
		const msg =
			'gerar-redirects: o vercel.json está desatualizado em relação ao conteúdo publicado. ' +
			'Rode "pnpm redirects:gerar" localmente e faça commit do vercel.json.';
		if (ON_VERCEL) {
			console.error(`${RED}${msg}${RESET}`);
			process.exitCode = 1;
		} else {
			console.warn(`${YELLOW}AVISO ${msg}${RESET}`);
		}
		return;
	}

	for (const c of conflitos) console.warn(`${YELLOW}conflito: ${c}${RESET}`);
	vercel.redirects = redirects;
	await writeFile(VERCEL_JSON, `${JSON.stringify(vercel, null, '\t')}\n`);
	console.log(
		`gerar-redirects: ${redirects.length} redirects gravados no vercel.json ` +
			`(${stats.manuais} manuais, ${stats.doConteudo} do frontmatter de ${stats.postsPublicados} posts publicados, ` +
			`${stats.deDuplicatas} de duplicatas; ${stats.duplicatasIgnoradas} duplicatas ignoradas por destino não publicado).`,
	);
}

main().catch((err) => {
	console.error('gerar-redirects falhou:', err);
	process.exitCode = 1;
});
