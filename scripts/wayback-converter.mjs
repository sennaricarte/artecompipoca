#!/usr/bin/env node
/**
 * Converte HTMLs aprovados do acervo Wayback em Markdown + frontmatter Astro.
 * Read-only por padrão. Com --apply: grava markdown e JSONs auxiliares.
 * Flags: --limite=N
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { cacheFileName } from './lib/nome-cache.mjs';
import { getScrubbedContentHtml } from './lib/extrair-post.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RECUPERADOS = join(ROOT, '_recuperados');
const METADADOS_CSV = join(RECUPERADOS, 'metadados.csv');
const HTML_DIR = join(RECUPERADOS, 'html');
const MD_RESENHAS = join(RECUPERADOS, 'markdown', 'resenhas');
const MD_ARTIGOS = join(RECUPERADOS, 'markdown', 'artigos');
const AUTORES_JSON = join(RECUPERADOS, 'autores-sugeridos.json');
const REDIRECTS_JSON = join(RECUPERADOS, 'redirects-sugeridos.json');

const APPLY = process.argv.includes('--apply');
const LIMITE = parseLimite(process.argv);

/**
 * @param {string[]} argv
 * @returns {number | null}
 */
function parseLimite(argv) {
	const arg = argv.find((a) => a.startsWith('--limite='));
	if (!arg) return null;
	const n = Number.parseInt(arg.slice('--limite='.length), 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Valor inválido para --limite: ${arg}`);
	}
	return n;
}

/**
 * @param {string} text
 * @returns {Record<string, string>[]}
 */
function parseCsv(text) {
	const cleaned = text.replace(/^\uFEFF/, '');
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;

	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		const next = cleaned[i + 1];

		if (inQuotes) {
			if (ch === '"' && next === '"') {
				field += '"';
				i += 1;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === ',') {
			row.push(field);
			field = '';
			continue;
		}
		if (ch === '\n') {
			row.push(field);
			field = '';
			if (row.length > 1 || row[0] !== '') rows.push(row);
			row = [];
			continue;
		}
		if (ch === '\r') continue;
		field += ch;
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	if (rows.length === 0) return [];

	const header = rows[0].map((h) => h.trim());
	return rows.slice(1).map((cols) => {
		/** @type {Record<string, string>} */
		const obj = {};
		for (let i = 0; i < header.length; i++) {
			obj[header[i]] = cols[i] ?? '';
		}
		return obj;
	});
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripAccents(text) {
	return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeKey(text) {
	return stripAccents(text).toLowerCase().trim();
}

/**
 * @param {string} nome
 * @returns {string}
 */
function autorIdFromNome(nome) {
	return stripAccents(nome || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * @param {string} urlNormalizada
 * @returns {string}
 */
function legacyPathFromUrl(urlNormalizada) {
	try {
		let path = new URL(urlNormalizada).pathname;
		if (!path.endsWith('/')) path += '/';
		return path;
	} catch {
		return urlNormalizada.startsWith('/') ? urlNormalizada : `/${urlNormalizada}`;
	}
}

/**
 * @param {string} urlNormalizada
 * @returns {string}
 */
function slugFromUrl(urlNormalizada) {
	let path;
	try {
		path = new URL(urlNormalizada).pathname;
	} catch {
		path = urlNormalizada;
	}
	let slug = path.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
	slug = slug.replace(/-(critica|resenha|review)$/i, '');
	slug = slug.replace(/-[23]$/, '');
	slug = slug.replace(/^review-/i, '');
	return slug;
}

/**
 * @param {string} title
 * @returns {string}
 */
function cleanTitleFrontmatter(title) {
	let t = (title || '').replace(/\s+/g, ' ').trim();
	t = t.replace(/^(crítica|critica|resenha|review)\s*[|:\-–—]\s*/i, '');
	t = t.replace(/\s*[|:\-–—]\s*(crítica|critica|resenha|review)\s*$/i, '');
	return t.trim();
}

/**
 * @param {string} categorias
 * @returns {'cinema' | 'series' | 'quadrinhos' | 'musica'}
 */
function deriveEditoria(categorias) {
	const blob = normalizeKey(categorias);
	if (/\bseries?\b/.test(blob)) return 'series';
	if (blob.includes('quadrinhos') || /\bhq\b/.test(blob)) return 'quadrinhos';
	if (blob.includes('musica')) return 'musica';
	return 'cinema';
}

/**
 * @param {string} categorias
 * @returns {'filme' | 'serie' | 'hq' | 'album'}
 */
function deriveTipoResenha(categorias) {
	const blob = normalizeKey(categorias);
	if (
		/\bseries?\b/.test(blob) ||
		blob.includes('resenhas de series') ||
		blob.includes('reviews de series') ||
		(blob.includes('review') && blob.includes('serie'))
	) {
		return 'serie';
	}
	if (blob.includes('quadrinhos') || /\bhq\b/.test(blob)) return 'hq';
	if (blob.includes('musica')) return 'album';
	return 'filme';
}

/**
 * @param {string} markdown
 * @returns {string}
 */
function descriptionFromMarkdown(markdown) {
	const lines = markdown.split(/\n+/).map((l) => l.trim()).filter(Boolean);
	let first = '';
	for (const line of lines) {
		if (/^#{1,6}\s/.test(line)) continue;
		if (/^[-*+]|\d+\./.test(line)) continue;
		if (/^>/.test(line)) continue;
		first = line.replace(/^[*_]+|[*_]+$/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
		break;
	}
	first = first.replace(/\s+/g, ' ').trim();
	if (!first) return '…';
	if (first.length <= 150) return first;
	const cut = first.slice(0, 150);
	const lastSpace = cut.lastIndexOf(' ');
	const base = lastSpace > 80 ? cut.slice(0, lastSpace) : cut;
	return `${base.trim()}…`;
}

/**
 * Prepara HTML do container para o Turndown.
 * @param {string} htmlFragment
 * @returns {string}
 */
function prepareHtmlForMarkdown(htmlFragment) {
	const $ = cheerio.load(`<div id="__root">${htmlFragment}</div>`);
	const root = $('#__root');

	root.find('script, style, iframe, noscript').remove();

	root.find('#HOTWordsTxt, [id="HOTWordsTxt"]').each((_, el) => {
		$(el).replaceWith($(el).contents());
	});

	// Links que envolvem apenas imagem → remover
	root.find('a').each((_, a) => {
		const $a = $(a);
		const kids = $a.contents().toArray().filter((n) => {
			if (n.type === 'text') return (n.data || '').trim().length > 0;
			return n.type === 'tag';
		});
		if (kids.length === 1 && kids[0].type === 'tag' && kids[0].tagName === 'img') {
			$a.remove();
		}
	});
	root.find('img').remove();

	// Links internos artecompipoca → só texto
	root.find('a[href]').each((_, a) => {
		const href = ($(a).attr('href') || '').toLowerCase();
		if (
			href.includes('artecompipoca.net') ||
			href.startsWith('/') ||
			href.startsWith('../')
		) {
			$(a).replaceWith($(a).contents());
		}
	});

	// Desembrulhar spans/divs (mantém formatação semântica nos filhos)
	let guard = 0;
	while (guard < 50 && root.find('span, div').length) {
		root.find('span, div').each((_, el) => {
			$(el).replaceWith($(el).contents());
		});
		guard += 1;
	}

	return root.html() || '';
}

/**
 * Parágrafo que é APENAS negrito (**texto**).
 * @param {string} paragraph
 * @returns {string | null} texto interno sem asteriscos
 */
function matchBoldOnlyParagraph(paragraph) {
	const t = paragraph.trim();
	const m = t.match(/^\*\*([^*]+)\*\*$/);
	if (!m) return null;
	if (t !== `**${m[1]}**`) return null;
	return m[1].trim();
}

/**
 * Negrito solo → ## subtítulo; sequência de negritos solos → lista "- ".
 * @param {string} markdown
 * @returns {string}
 */
function promoteBoldParagraphs(markdown) {
	const parts = markdown.split(/\n\n+/);
	/** @type {string[]} */
	const out = [];
	let i = 0;

	while (i < parts.length) {
		const boldText = matchBoldOnlyParagraph(parts[i]);
		if (boldText == null) {
			out.push(parts[i]);
			i += 1;
			continue;
		}

		/** @type {string[]} */
		const sequence = [boldText];
		let j = i + 1;
		while (j < parts.length) {
			const next = matchBoldOnlyParagraph(parts[j]);
			if (next == null) break;
			sequence.push(next);
			j += 1;
		}

		if (sequence.length >= 2) {
			out.push(sequence.map((t) => `- ${t}`).join('\n'));
			i = j;
			continue;
		}

		const text = sequence[0];
		const qualifiesSubtitle =
			text.length <= 80 && !/[.!:]$/.test(text);
		if (qualifiesSubtitle) {
			out.push(`## ${text}`);
		} else {
			out.push(parts[i]);
		}
		i += 1;
	}

	return out.join('\n\n');
}

/**
 * @param {string} html
 * @returns {string}
 */
function htmlToMarkdown(html) {
	const prepared = prepareHtmlForMarkdown(html);
	const turndown = new TurndownService({
		headingStyle: 'atx',
		codeBlockStyle: 'fenced',
		emDelimiter: '*',
		bulletListMarker: '-',
	});
	turndown.remove(['script', 'style', 'iframe', 'img', 'noscript']);

	let md = turndown.turndown(prepared);

	md = md
		.replace(/\u00a0/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/[“”]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/^\s+|\s+$/g, '');

	// Remover parágrafos/linhas vazias residuais
	md = md
		.split(/\n/)
		.filter((line, i, arr) => {
			if (line.trim() !== '') return true;
			const prev = arr[i - 1]?.trim() ?? '';
			const next = arr[i + 1]?.trim() ?? '';
			return prev !== '' && next !== '';
		})
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	md = promoteBoldParagraphs(md);

	return md;
}

/**
 * @param {string} value
 * @returns {string}
 */
function yamlQuote(value) {
	const s = String(value ?? '');
	if (/[:#{}[\],&*!|>'"%@`]|^\s|\s$|\n/.test(s) || s === '') {
		return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	}
	return s;
}

/**
 * @param {Record<string, string | number | boolean>} fields
 * @param {string} body
 * @returns {string}
 */
function buildMarkdownFile(fields, body) {
	const lines = ['---'];
	for (const [k, v] of Object.entries(fields)) {
		if (typeof v === 'boolean' || typeof v === 'number') {
			lines.push(`${k}: ${v}`);
		} else {
			lines.push(`${k}: ${yamlQuote(v)}`);
		}
	}
	lines.push('---', '', body.trim(), '');
	return lines.join('\n');
}

async function main() {
	let csvText;
	try {
		csvText = await readFile(METADADOS_CSV, 'utf8');
	} catch {
		console.error(`Arquivo não encontrado: ${METADADOS_CSV}`);
		console.error('Rode antes: pnpm wayback:extrair --apply');
		process.exitCode = 1;
		return;
	}

	let rows = parseCsv(csvText).filter((r) => (r.aprovar || '').trim() === 'sim');
	if (LIMITE != null) rows = rows.slice(0, LIMITE);

	/** @type {{ row: Record<string, string>, collection: 'resenhas' | 'artigos' | null, slug: string, titleLimpo: string, titleOriginal: string, urlNova: string, editoria?: string, tipo?: string, autorId: string, autorNome: string, markdown?: string, filePath?: string }[]} */
	const planned = [];
	/** @type {{ source: string, destination: string, permanent: boolean }[]} */
	const redirects = [];
	/** @type {Map<string, { id: string, nome: string, bio: string }>} */
	const autores = new Map();
	/** @type {Map<string, string[]>} */
	const slugOwners = new Map();

	let resenhasCount = 0;
	let artigosCount = 0;
	let soRedirect = 0;
	let falhasHtml = 0;

	for (const row of rows) {
		const titleOriginal = row.titulo || '';
		const titleLimpo = cleanTitleFrontmatter(titleOriginal);
		const legacyUrl = legacyPathFromUrl(row.url_normalizada || '');
		const autorNome = (row.autor || '').trim() || 'sem-autor';
		const autorId = autorIdFromNome(autorNome) || 'sem-autor';

		if (!autores.has(autorId)) {
			autores.set(autorId, { id: autorId, nome: autorNome, bio: '' });
		}

		const tipoPagina = (row.tipo_pagina || '').trim();
		if (tipoPagina !== 'post') {
			soRedirect += 1;
			redirects.push(
				{ source: legacyUrl, destination: '', permanent: true },
				{ source: `/index.php${legacyUrl}`, destination: '', permanent: true },
			);
			planned.push({
				row,
				collection: null,
				slug: '',
				titleLimpo,
				titleOriginal,
				urlNova: '',
				autorId,
				autorNome,
			});
			continue;
		}

		const isResenha = (row.tipo_final || '').trim() === 'resenha';
		const collection = isResenha ? 'resenhas' : 'artigos';
		const slug = slugFromUrl(row.url_normalizada || '');
		if (!slug) {
			falhasHtml += 1;
			continue;
		}

		const editoria = isResenha ? undefined : deriveEditoria(row.categorias || '');
		const tipo = isResenha ? deriveTipoResenha(row.categorias || '') : undefined;
		const urlNova = isResenha
			? `/resenhas/${slug}/`
			: `/${editoria}/${slug}/`;

		const key = `${collection}:${slug}`;
		const owners = slugOwners.get(key) || [];
		owners.push(row.url_normalizada || slug);
		slugOwners.set(key, owners);

		const arquivo = row.arquivo_cache || cacheFileName(row.url_normalizada);
		const htmlPath = join(HTML_DIR, arquivo);
		let htmlDoc;
		try {
			await access(htmlPath);
			htmlDoc = await readFile(htmlPath, 'utf8');
		} catch {
			falhasHtml += 1;
			console.warn(`Sem HTML em cache: ${arquivo}`);
			continue;
		}

		const content = getScrubbedContentHtml(htmlDoc);
		if (!content) {
			falhasHtml += 1;
			console.warn(`Sem container de conteúdo: ${arquivo}`);
			continue;
		}

		const markdown = htmlToMarkdown(content.html);
		const description = descriptionFromMarkdown(markdown);

		/** @type {Record<string, string | number | boolean>} */
		const fm = {
			title: titleLimpo,
			description,
			pubDate: row.data_publicacao || '',
			autor: autorId,
			origem: 'arquivo',
			legacyUrl,
			draft: true,
		};
		if (isResenha) {
			fm.obra = titleLimpo;
			fm.tipo = /** @type {string} */ (tipo);
		} else {
			fm.editoria = /** @type {string} */ (editoria);
		}

		const body = buildMarkdownFile(fm, markdown);
		const dir = isResenha ? MD_RESENHAS : MD_ARTIGOS;
		const filePath = join(dir, `${slug}.md`);

		if (isResenha) resenhasCount += 1;
		else artigosCount += 1;

		redirects.push(
			{ source: legacyUrl, destination: urlNova, permanent: true },
			{ source: `/index.php${legacyUrl}`, destination: urlNova, permanent: true },
		);

		planned.push({
			row,
			collection,
			slug,
			titleLimpo,
			titleOriginal,
			urlNova,
			editoria,
			tipo,
			autorId,
			autorNome,
			markdown: body,
			filePath,
		});
	}

	const colisoes = [...slugOwners.entries()].filter(([, urls]) => urls.length > 1);

	console.log('\n=== Resumo wayback:converter ===');
	console.log(`Linhas aprovar=sim (processadas): ${rows.length}`);
	console.log(`Markdown resenhas:  ${resenhasCount}`);
	console.log(`Markdown artigos:   ${artigosCount}`);
	console.log(`Só redirect (não-post): ${soRedirect}`);
	console.log(`Falhas HTML/conteúdo: ${falhasHtml}`);
	console.log(`Autores sugeridos:  ${autores.size}`);
	console.log(`Redirects:          ${redirects.length}`);

	console.log('\nColisões de slug:');
	if (colisoes.length === 0) console.log('  (nenhuma)');
	for (const [key, urls] of colisoes) {
		console.log(`  ${key}:`);
		for (const u of urls) console.log(`    - ${u}`);
	}

	const exemplos = planned
		.filter((p) => p.collection)
		.slice(0, 5);
	console.log('\nExemplos title → limpo → slug:');
	for (const ex of exemplos) {
		console.log(`  "${ex.titleOriginal}" → "${ex.titleLimpo}" → ${ex.slug}`);
	}

	if (!APPLY) {
		console.log('\nModo read-only (sem --apply). Nada foi gravado.');
		console.log('Para gravar: pnpm wayback:converter --apply');
		console.log('Teste: pnpm wayback:converter --apply --limite=5');
		return;
	}

	await mkdir(MD_RESENHAS, { recursive: true });
	await mkdir(MD_ARTIGOS, { recursive: true });

	for (const item of planned) {
		if (!item.markdown || !item.filePath) continue;
		await writeFile(item.filePath, item.markdown, 'utf8');
	}

	const autoresArr = [...autores.values()].sort((a, b) =>
		a.id.localeCompare(b.id, 'pt-BR'),
	);
	await writeFile(AUTORES_JSON, JSON.stringify(autoresArr, null, 2) + '\n', 'utf8');
	await writeFile(REDIRECTS_JSON, JSON.stringify(redirects, null, 2) + '\n', 'utf8');

	console.log(`\nGravados ${resenhasCount + artigosCount} markdown(s).`);
	console.log(`Autores: ${AUTORES_JSON}`);
	console.log(`Redirects: ${REDIRECTS_JSON}`);
}

main().catch((err) => {
	console.error('Falha no conversor Wayback:', err);
	process.exitCode = 1;
});
