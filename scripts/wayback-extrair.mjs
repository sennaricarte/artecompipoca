#!/usr/bin/env node
/**
 * Extrai metadados WordPress dos HTMLs em cache (offline).
 * Read-only por padrão. Com --apply: grava _recuperados/metadados.csv.
 * Flags: --amostra=N
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { cacheFileName } from './lib/nome-cache.mjs';
import { extractPalavras } from './lib/extrair-post.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RECUPERADOS = join(ROOT, '_recuperados');
const INVENTARIO_CSV = join(RECUPERADOS, 'inventario.csv');
const HTML_DIR = join(RECUPERADOS, 'html');
const METADADOS_CSV = join(RECUPERADOS, 'metadados.csv');

const APPLY = process.argv.includes('--apply');
const AMOSTRA = parseAmostra(process.argv);

/**
 * @param {string[]} argv
 * @returns {number | null}
 */
function parseAmostra(argv) {
	const arg = argv.find((a) => a.startsWith('--amostra='));
	if (!arg) return null;
	const n = Number.parseInt(arg.slice('--amostra='.length), 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Valor inválido para --amostra: ${arg}`);
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
 * @param {string} value
 * @returns {string}
 */
function csvEscape(value) {
	const s = String(value ?? '');
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
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
 * @param {string} raw
 * @returns {string}
 */
function cleanTitle(raw) {
	let t = raw.replace(/\s+/g, ' ').trim();
	t = t.replace(
		/\s*[|\u2013\u2014\-]\s*Arte\s+Com\s+Pipoca\s*$/i,
		'',
	);
	return t.trim();
}

/**
 * @param {string} raw
 * @returns {string}
 */
function normalizeDate(raw) {
	const s = raw.trim();
	if (!s) return '';

	const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
	if (iso) return iso[1];

	const br = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
	if (br) {
		const d = br[1].padStart(2, '0');
		const m = br[2].padStart(2, '0');
		return `${br[3]}-${m}-${d}`;
	}

	const parsed = Date.parse(s);
	if (!Number.isNaN(parsed)) {
		return new Date(parsed).toISOString().slice(0, 10);
	}

	return '';
}

/**
 * @param {string} classAttr
 * @param {string} prefix
 * @returns {string[]}
 */
function classesWithPrefix(classAttr, prefix) {
	if (!classAttr) return [];
	return classAttr
		.split(/\s+/)
		.filter((c) => c.startsWith(prefix) && c.length > prefix.length)
		.map((c) => c.slice(prefix.length).replace(/-/g, ' ').trim())
		.filter(Boolean);
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractTitulo($) {
	const h1 = $('h1.entry-title').first().text();
	if (h1.trim()) return cleanTitle(h1);

	const og = $('meta[property="og:title"]').attr('content');
	if (og?.trim()) return cleanTitle(og);

	const title = $('title').first().text();
	if (title.trim()) return cleanTitle(title);

	return '';
}

/**
 * Autor/data no bloco do H1 (tema antigo: .heading-author + .heading-date DD/MM/AAAA).
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ autor: string, data: string }}
 */
function extractAutorDataNearH1($) {
	const headingDate = $('.heading-date').first().text().replace(/\s+/g, ' ').trim();
	const headingAuthor = $('.heading-author').first().text().replace(/\s+/g, ' ').trim();
	if (headingDate || headingAuthor) {
		return { autor: headingAuthor, data: headingDate ? normalizeDate(headingDate) : '' };
	}

	const h1 = $('h1').first();
	if (!h1.length) return { autor: '', data: '' };

	const title = h1.text().replace(/\s+/g, ' ').trim();
	const parentText = h1.parent().text().replace(/\s+/g, ' ').trim();
	const dateMatch = parentText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
	if (!dateMatch || dateMatch.index == null) return { autor: '', data: '' };

	const data = normalizeDate(dateMatch[1]);
	let before = parentText.slice(0, dateMatch.index).trim();
	if (title && before.startsWith(title)) {
		before = before.slice(title.length).trim();
	}
	before = before.replace(/^[\s\-–—|,]+/, '').trim();
	return { autor: before, data };
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractData($) {
	const candidates = [
		$('meta[property="article:published_time"]').attr('content'),
		$('time.entry-date').attr('datetime'),
		$('time[datetime]').attr('datetime'),
		$('abbr.published').attr('title'),
		$('.heading-date').first().text(),
	];
	for (const c of candidates) {
		if (!c?.trim()) continue;
		const norm = normalizeDate(c);
		if (norm) return norm;
	}
	return extractAutorDataNearH1($).data;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractAutor($) {
	const candidates = [
		$('a[rel="author"]').first().text(),
		$('.author .fn').first().text(),
		$('.vcard .fn').first().text(),
		$('meta[name="author"]').attr('content'),
		$('.heading-author').first().text(),
	];
	for (const c of candidates) {
		if (c?.trim()) return c.replace(/\s+/g, ' ').trim();
	}
	return extractAutorDataNearH1($).autor;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractCategorias($) {
	const fromLinks = [];
	$('a[rel="category tag"]').each((_, el) => {
		const t = $(el).text().replace(/\s+/g, ' ').trim();
		if (t) fromLinks.push(t);
	});
	if (fromLinks.length) return [...new Set(fromLinks)].join(' | ');

	const classSources = [
		$('article').first().attr('class') || '',
		$('body').attr('class') || '',
	].join(' ');
	const fromClasses = classesWithPrefix(classSources, 'category-');
	return [...new Set(fromClasses)].join(' | ');
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractTags($) {
	const fromLinks = [];
	$('a[rel="tag"]').each((_, el) => {
		const rel = ($(el).attr('rel') || '').toLowerCase();
		if (rel.includes('category')) return;
		const t = $(el).text().replace(/\s+/g, ' ').trim();
		if (t) fromLinks.push(t);
	});
	if (fromLinks.length) return [...new Set(fromLinks)].join(' | ');

	const classSources = [
		$('article').first().attr('class') || '',
		$('body').attr('class') || '',
	].join(' ');
	const fromClasses = classesWithPrefix(classSources, 'tag-');
	return [...new Set(fromClasses)].join(' | ');
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractWpPostId($) {
	const bodyClass = $('body').attr('class') || '';
	const m = bodyClass.match(/(?:^|\s)postid-(\d+)(?:\s|$)/i);
	return m ? m[1] : '';
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function extractTipoPagina($) {
	const classes = (($('body').attr('class') || '').toLowerCase()).split(/\s+/);
	const has = (name) => classes.includes(name);

	if (has('single') || has('single-post')) return 'post';
	if (has('page') || has('page-template') || classes.some((c) => c.startsWith('page-id-'))) {
		return 'pagina';
	}
	if (
		has('archive') ||
		has('category') ||
		has('tag') ||
		has('home') ||
		has('blog')
	) {
		return 'listagem';
	}
	return 'desconhecido';
}

/**
 * @param {string} categorias
 * @param {string} tipoProvavel
 * @param {string} tipoPagina
 * @returns {string}
 */
function computeTipoFinal(categorias, tipoProvavel, tipoPagina) {
	if (tipoPagina !== 'post' && tipoPagina !== 'pagina') {
		return 'listagem';
	}

	const cats = categorias
		.split('|')
		.map((c) => normalizeKey(c))
		.filter(Boolean);
	const blob = cats.join(' ');

	const hasAny = (terms) => terms.some((t) => blob.includes(t));

	if (hasAny(['critica', 'resenha', 'review', 'oscar'])) return 'resenha';
	if (hasAny(['top lista', 'top-lista', 'ranking'])) return 'lista';
	// "top lista" as separate tokens: also match category literally "top lista"
	if (cats.some((c) => c.includes('top') && c.includes('lista'))) return 'lista';

	if (hasAny(['pipocacast', 'podcast', 'balde', 'sete reinos', 'na mesa'])) {
		return 'podcast';
	}
	if (
		hasAny([
			'noticia',
			'trailer',
			'em breve',
			'estreia',
			'nos cinemas',
			'promocao',
		])
	) {
		return 'noticia';
	}

	return tipoProvavel || 'outro';
}

/**
 * @param {{
 *   tem_backlink: string,
 *   seletor_usado: string,
 *   palavras: number,
 *   tipo_pagina: string,
 *   tipo_final: string,
 * }} row
 * @returns {{ sugestao: 'sim' | 'revisar' | 'nao', motivo: string }}
 */
function suggestAprovacao(row) {
	if (row.tem_backlink === 'sim') {
		return { sugestao: 'sim', motivo: 'backlink' };
	}
	if (row.seletor_usado === 'nenhum' || row.palavras === 0) {
		return { sugestao: 'nao', motivo: 'sem conteudo' };
	}
	if (row.tipo_pagina !== 'post') {
		return { sugestao: 'nao', motivo: 'nao e post' };
	}
	if (row.tipo_final === 'noticia') {
		return { sugestao: 'nao', motivo: 'noticia' };
	}
	if (row.palavras < 150) {
		return { sugestao: 'nao', motivo: 'curto' };
	}
	if (
		(row.tipo_final === 'resenha' || row.tipo_final === 'lista') &&
		row.palavras >= 400
	) {
		return { sugestao: 'sim', motivo: 'resenha/lista forte' };
	}
	if (
		(row.tipo_final === 'resenha' || row.tipo_final === 'lista') &&
		row.palavras >= 150 &&
		row.palavras <= 399
	) {
		return { sugestao: 'revisar', motivo: 'resenha/lista media' };
	}
	if (row.tipo_final === 'podcast') {
		return { sugestao: 'revisar', motivo: 'podcast' };
	}
	if (row.tipo_final === 'outro' && row.palavras >= 400) {
		return { sugestao: 'revisar', motivo: 'outro longo' };
	}
	return { sugestao: 'nao', motivo: 'outro medio' };
}

/**
 * @param {string} html
 * @param {Record<string, string>} invRow
 * @param {string} arquivoCache
 */
function extractFromHtml(html, invRow, arquivoCache) {
	const $ = cheerio.load(html);
	const titulo = extractTitulo($);
	const data_publicacao = extractData($);
	const autor = extractAutor($);
	const categorias = extractCategorias($);
	const tags = extractTags($);
	const wp_post_id = extractWpPostId($);
	const tipo_pagina = extractTipoPagina($);
	const { palavras, seletor_usado } = extractPalavras($);
	const tipo_provavel = invRow.tipo_provavel || '';
	const tipo_final = computeTipoFinal(categorias, tipo_provavel, tipo_pagina);
	const tem_backlink = invRow.tem_backlink || 'nao';

	const { sugestao, motivo } = suggestAprovacao({
		tem_backlink,
		seletor_usado,
		palavras,
		tipo_pagina,
		tipo_final,
	});

	return {
		url_normalizada: invRow.url_normalizada || '',
		tem_backlink,
		tipo_provavel,
		tipo_final,
		titulo,
		data_publicacao,
		autor,
		categorias,
		tags,
		palavras,
		tipo_pagina,
		wp_post_id,
		seletor_usado,
		arquivo_cache: arquivoCache,
		sugestao,
		motivo,
		aprovar: sugestao === 'revisar' ? '' : sugestao,
	};
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[]}
 */
function sampleRandom(items, size) {
	const copy = [...items];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy.slice(0, size);
}

/**
 * @param {number} n
 * @returns {string}
 */
function palavraFaixa(n) {
	if (n < 150) return '<150';
	if (n < 400) return '150–399';
	if (n < 800) return '400–799';
	return '800+';
}

/**
 * @param {ReturnType<typeof extractFromHtml>[]} rows
 */
async function writeMetadadosCsv(rows) {
	await mkdir(RECUPERADOS, { recursive: true });
	const header = [
		'url_normalizada',
		'tem_backlink',
		'tipo_provavel',
		'tipo_final',
		'titulo',
		'data_publicacao',
		'autor',
		'categorias',
		'tags',
		'palavras',
		'tipo_pagina',
		'wp_post_id',
		'seletor_usado',
		'arquivo_cache',
		'sugestao',
		'motivo',
		'aprovar',
	];
	const lines = [
		header.join(','),
		...rows.map((r) =>
			[
				r.url_normalizada,
				r.tem_backlink,
				r.tipo_provavel,
				r.tipo_final,
				r.titulo,
				r.data_publicacao,
				r.autor,
				r.categorias,
				r.tags,
				r.palavras,
				r.tipo_pagina,
				r.wp_post_id,
				r.seletor_usado,
				r.arquivo_cache,
				r.sugestao,
				r.motivo,
				r.aprovar,
			]
				.map(csvEscape)
				.join(','),
		),
	];
	await writeFile(METADADOS_CSV, '\uFEFF' + lines.join('\n') + '\n', 'utf8');
	console.log(`CSV gravado: ${METADADOS_CSV}`);
}

async function main() {
	let csvText;
	try {
		csvText = await readFile(INVENTARIO_CSV, 'utf8');
	} catch {
		console.error(`Arquivo não encontrado: ${INVENTARIO_CSV}`);
		process.exitCode = 1;
		return;
	}

	const inventario = parseCsv(csvText);
	/** @type {ReturnType<typeof extractFromHtml>[]} */
	const resultados = [];
	let semCache = 0;

	for (const row of inventario) {
		const url = row.url_normalizada;
		if (!url) {
			semCache += 1;
			continue;
		}
		const arquivo = cacheFileName(url);
		const path = join(HTML_DIR, arquivo);
		try {
			await access(path);
		} catch {
			semCache += 1;
			continue;
		}

		const html = await readFile(path, 'utf8');
		resultados.push(extractFromHtml(html, row, arquivo));
	}

	const sugestaoOrder = { sim: 0, revisar: 1, nao: 2 };
	resultados.sort((a, b) => {
		const sa = sugestaoOrder[a.sugestao] ?? 9;
		const sb = sugestaoOrder[b.sugestao] ?? 9;
		if (sa !== sb) return sa - sb;
		if (a.tem_backlink !== b.tem_backlink) {
			return a.tem_backlink === 'sim' ? -1 : 1;
		}
		const tipoCmp = a.tipo_final.localeCompare(b.tipo_final, 'pt-BR');
		if (tipoCmp !== 0) return tipoCmp;
		return b.palavras - a.palavras;
	});

	/** @type {Record<string, number>} */
	const porTipoFinal = {};
	/** @type {Record<string, number>} */
	const porAutor = {};
	/** @type {Record<string, number>} */
	const porCategoria = {};
	/** @type {Record<string, number>} */
	const faixasGeral = { '<150': 0, '150–399': 0, '400–799': 0, '800+': 0 };
	/** @type {Record<string, Record<string, number>>} */
	const faixasPorTipo = {};
	/** @type {Record<string, number>} */
	const porSugestao = { sim: 0, revisar: 0, nao: 0 };
	/** @type {Record<string, number>} */
	const porMotivo = {};
	/** @type {Record<string, number>} */
	const simPorTipo = {};
	/** @type {Record<string, number>} */
	const simPorAutor = {};
	let mudaramTipo = 0;
	/** @type {string[]} */
	const semSeletor = [];

	for (const r of resultados) {
		porTipoFinal[r.tipo_final] = (porTipoFinal[r.tipo_final] ?? 0) + 1;
		if (r.tipo_final !== r.tipo_provavel) mudaramTipo += 1;

		const autor = r.autor || '(sem autor)';
		porAutor[autor] = (porAutor[autor] ?? 0) + 1;

		for (const cat of r.categorias.split('|').map((c) => c.trim()).filter(Boolean)) {
			porCategoria[cat] = (porCategoria[cat] ?? 0) + 1;
		}

		const faixa = palavraFaixa(r.palavras);
		faixasGeral[faixa] += 1;
		if (!faixasPorTipo[r.tipo_final]) {
			faixasPorTipo[r.tipo_final] = {
				'<150': 0,
				'150–399': 0,
				'400–799': 0,
				'800+': 0,
			};
		}
		faixasPorTipo[r.tipo_final][faixa] += 1;

		porSugestao[r.sugestao] = (porSugestao[r.sugestao] ?? 0) + 1;
		porMotivo[r.motivo] = (porMotivo[r.motivo] ?? 0) + 1;
		if (r.sugestao === 'sim') {
			simPorTipo[r.tipo_final] = (simPorTipo[r.tipo_final] ?? 0) + 1;
			simPorAutor[autor] = (simPorAutor[autor] ?? 0) + 1;
		}

		if (r.seletor_usado === 'nenhum') {
			semSeletor.push(r.arquivo_cache);
		}
	}

	console.log('\n=== Resumo wayback:extrair ===');
	console.log(`Arquivos processados:     ${resultados.length}`);
	console.log(`Inventário sem cache:     ${semCache}`);
	console.log(`Tipos que mudaram:        ${mudaramTipo}`);

	console.log('\nPor tipo_final:');
	for (const tipo of Object.keys(porTipoFinal).sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
		console.log(`  ${tipo}: ${porTipoFinal[tipo]}`);
	}

	console.log('\nTop 40 categorias:');
	const topCats = Object.entries(porCategoria)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))
		.slice(0, 40);
	if (topCats.length === 0) console.log('  (nenhuma)');
	for (const [cat, n] of topCats) {
		console.log(`  ${cat}: ${n}`);
	}

	console.log('\nPor autor:');
	const autoresOrdenados = Object.entries(porAutor).sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'),
	);
	for (const [autor, n] of autoresOrdenados) {
		console.log(`  ${autor}: ${n}`);
	}

	console.log('\nFaixas de palavras (geral):');
	for (const faixa of ['<150', '150–399', '400–799', '800+']) {
		console.log(`  ${faixa}: ${faixasGeral[faixa]}`);
	}

	console.log('\nFaixas de palavras por tipo_final:');
	for (const tipo of Object.keys(faixasPorTipo).sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
		const f = faixasPorTipo[tipo];
		console.log(
			`  ${tipo}: <150=${f['<150']} | 150–399=${f['150–399']} | 400–799=${f['400–799']} | 800+=${f['800+']}`,
		);
	}

	console.log(`\nSeletor "nenhum": ${semSeletor.length}`);
	for (const path of semSeletor.slice(0, 10)) {
		console.log(`  ${path}`);
	}
	if (semSeletor.length > 10) {
		console.log(`  … e mais ${semSeletor.length - 10}`);
	}

	console.log('\nPor sugestao:');
	for (const s of ['sim', 'revisar', 'nao']) {
		console.log(`  ${s}: ${porSugestao[s] ?? 0}`);
	}

	console.log('\nPor motivo:');
	const motivosOrdenados = Object.entries(porMotivo).sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'),
	);
	for (const [motivo, n] of motivosOrdenados) {
		console.log(`  ${motivo}: ${n}`);
	}

	console.log('\nSugestão "sim" por tipo_final:');
	const simTipos = Object.entries(simPorTipo).sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'),
	);
	if (simTipos.length === 0) console.log('  (nenhum)');
	for (const [tipo, n] of simTipos) {
		console.log(`  ${tipo}: ${n}`);
	}

	console.log('\nSugestão "sim" por autor:');
	const simAutores = Object.entries(simPorAutor).sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'),
	);
	if (simAutores.length === 0) console.log('  (nenhum)');
	for (const [autor, n] of simAutores) {
		console.log(`  ${autor}: ${n}`);
	}

	if (AMOSTRA != null) {
		const amostra = sampleRandom(resultados, AMOSTRA);
		console.log(`\nAmostra aleatória (${amostra.length}):`);
		for (const r of amostra) {
			console.log(
				`  [${r.sugestao}/${r.motivo}] [${r.tipo_final}] ${r.palavras} palavras | ${r.categorias || '(sem cat)'} | ${r.titulo || '(sem título)'}`,
			);
		}
	}

	if (APPLY) {
		await writeMetadadosCsv(resultados);
	} else {
		console.log('\nModo read-only (sem --apply). CSV não foi gravado.');
		console.log('Para gravar: pnpm wayback:extrair --apply');
		console.log('Com amostra: pnpm wayback:extrair --amostra=20');
	}
}

main().catch((err) => {
	console.error('Falha na extração Wayback:', err);
	process.exitCode = 1;
});
