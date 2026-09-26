#!/usr/bin/env node
/**
 * Busca candidatos no Wikidata para fichas de resenhas (filme/série).
 * Read-only por padrão. Com --apply: rebusca dados pelo wikidataId do CSV e grava.
 * Com --segunda-busca: reprocessa linhas do CSV com titulo_busca e aprovar vazio.
 * Uso: pnpm fichas:wikidata [--apply] [--limite=N] | [--segunda-busca]
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESENHAS = join(ROOT, 'src', 'content', 'resenhas');
const OUT_CSV = join(ROOT, '_recuperados', 'fichas-candidatas.csv');
const APPLY = process.argv.includes('--apply');
const SEGUNDA_BUSCA = process.argv.includes('--segunda-busca');
const LIMITE_ARG = process.argv.find((a) => a.startsWith('--limite='));
const LIMITE = LIMITE_ARG ? Number(LIMITE_ARG.slice('--limite='.length)) : null;

const USER_AGENT =
	'ArteComPipocaBot/1.0 (https://artecompipoca.net; contato@artecompipoca.net)';
const SEARCH_URL = 'https://www.wikidata.org/w/api.php';
const SPARQL_URL = 'https://query.wikidata.org/sparql';

const CLASSE_FILME = 'Q11424';
const CLASSE_FILME_ANIMACAO = 'Q202866';
const CLASSE_LONGA_ANIMACAO = 'Q29168811';
const CLASSE_SERIE = 'Q5398426';
const CLASSE_MINISSERIE = 'Q1259759';
const CLASSE_SERIE_ANIMADA = 'Q581714';
const CLASSES_FILME = [CLASSE_FILME, CLASSE_FILME_ANIMACAO, CLASSE_LONGA_ANIMACAO];
const CLASSES_SERIE = [CLASSE_SERIE, CLASSE_MINISSERIE, CLASSE_SERIE_ANIMADA];

const DELAY_MS = 1000;

/**
 * @param {number} ms
 */
function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [attempt]
 */
async function fetchRetry(url, init = {}, attempt = 0) {
	const headers = {
		'User-Agent': USER_AGENT,
		...(init.headers || {}),
	};
	const res = await fetch(url, { ...init, headers });
	if (res.status === 429 || res.status >= 500) {
		if (attempt >= 5) {
			throw new Error(`HTTP ${res.status} após retries: ${url}`);
		}
		const backoff = DELAY_MS * 2 ** attempt;
		console.warn(`  retry ${res.status}, aguardando ${backoff}ms…`);
		await sleep(backoff);
		return fetchRetry(url, init, attempt + 1);
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`HTTP ${res.status}: ${url}\n${text.slice(0, 200)}`);
	}
	return res;
}

/**
 * @param {string} dir
 * @param {string[]} out
 */
async function walkMd(dir, out = []) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walkMd(p, out);
		else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
	}
	return out;
}

/**
 * @param {string} raw
 */
function splitFrontmatter(raw) {
	const text = String(raw || '').replace(/^\uFEFF/, '');
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
	if (!m) return null;
	return {
		fm: m[1],
		body: text.slice(m[0].length),
		open: '---\n',
		close: '\n---\n',
	};
}

/**
 * @param {string} fm
 * @param {string} key
 */
function getScalar(fm, key) {
	const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
	if (!m) return '';
	let v = m[1].trim();
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		v = v.slice(1, -1);
	}
	return v;
}

/**
 * @param {string} s
 */
function normalize(s) {
	return String(s || '')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/**
 * @param {string} title
 * @returns {number | null}
 */
function yearFromTitle(title) {
	const m = String(title).match(/\((\d{4})\)/);
	return m ? Number(m[1]) : null;
}

/**
 * Remove ano entre parênteses e artigos iniciais (O, A, Os, As).
 * @param {string} obra
 */
function simplifyObra(obra) {
	return String(obra || '')
		.replace(/\s*\(\d{4}\)\s*/g, ' ')
		.replace(/^(O|A|Os|As)\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Busca textual Wikidata com filtro P31.
 * @param {string} obra
 * @param {string} classId
 * @returns {Promise<string[]>}
 */
async function searchByClass(obra, classId) {
	const term = String(obra || '').trim();
	if (!term) return [];
	const srsearch = `${term} haswbstatement:P31=${classId}`;
	const params = new URLSearchParams({
		action: 'query',
		list: 'search',
		srsearch,
		srlimit: '10',
		format: 'json',
	});
	const res = await fetchRetry(`${SEARCH_URL}?${params}`);
	await sleep(DELAY_MS);
	const data = await res.json();
	const hits = data.query?.search || [];
	return hits
		.map((h) => String(h.title || ''))
		.filter((id) => /^Q\d+$/.test(id));
}

/**
 * Busca textual em várias classes P31, preservando ordem e deduplicando.
 * @param {string} obra
 * @param {string[]} classIds
 * @returns {Promise<string[]>}
 */
async function searchByClasses(obra, classIds) {
	/** @type {string[]} */
	const out = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const classId of classIds) {
		const ids = await searchByClass(obra, classId);
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/**
 * @param {string} obra
 * @param {'filme' | 'serie'} tipo
 * @returns {Promise<string[]>}
 */
async function searchIds(obra, tipo) {
	/** @param {string} q */
	async function once(q) {
		if (tipo === 'filme') {
			return searchByClasses(q, CLASSES_FILME);
		}
		let ids = await searchByClass(q, CLASSE_SERIE);
		if (ids.length) return ids;
		return searchByClasses(q, [CLASSE_MINISSERIE, CLASSE_SERIE_ANIMADA]);
	}

	let ids = await once(obra);
	if (ids.length) return ids;

	const simplified = simplifyObra(obra);
	if (simplified && simplified !== obra.trim()) {
		ids = await once(simplified);
	}
	return ids;
}

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string, any>>}
 */
async function wbgetentities(ids) {
	if (!ids.length) return {};
	const params = new URLSearchParams({
		action: 'wbgetentities',
		ids: ids.join('|'),
		props: 'labels|aliases|claims|sitelinks',
		languages: 'pt-br|pt|en',
		languagefallback: '1',
		format: 'json',
	});
	const res = await fetchRetry(`${SEARCH_URL}?${params}`);
	await sleep(DELAY_MS);
	const data = await res.json();
	return data.entities || {};
}

/**
 * @param {any} entity
 * @param {string[]} langs
 * @returns {string}
 */
function pickLabel(entity, langs = ['pt-br', 'pt', 'en']) {
	const labels = entity?.labels || {};
	for (const lang of langs) {
		if (labels[lang]?.value) return labels[lang].value;
	}
	const any = Object.values(labels)[0];
	return any?.value || entity?.id || '';
}

/**
 * Rótulos e apelidos em pt-br, pt, en + P1476.
 * @param {any} entity
 * @returns {{ rotulo: string, titulos: string[], tituloOriginal: string }}
 */
function collectTitulos(entity) {
	/** @type {Set<string>} */
	const titulos = new Set();
	const langs = ['pt-br', 'pt', 'en'];
	for (const lang of langs) {
		const lab = entity.labels?.[lang]?.value;
		if (lab) titulos.add(lab);
		for (const a of entity.aliases?.[lang] || []) {
			if (a?.value) titulos.add(a.value);
		}
	}
	let tituloOriginal = '';
	for (const claim of entity.claims?.P1476 || []) {
		const v = claim?.mainsnak?.datavalue?.value;
		const text = typeof v === 'string' ? v : v?.text;
		if (text) {
			titulos.add(text);
			if (!tituloOriginal) tituloOriginal = text;
		}
	}
	const rotulo = pickLabel(entity);
	if (rotulo) titulos.add(rotulo);
	return { rotulo, titulos: [...titulos], tituloOriginal };
}

/**
 * @param {any} entity
 * @param {string} prop
 * @returns {string[]}
 */
function claimEntityIds(entity, prop) {
	/** @type {string[]} */
	const out = [];
	for (const claim of entity.claims?.[prop] || []) {
		const id = claim?.mainsnak?.datavalue?.value?.id;
		if (id && /^Q\d+$/.test(id)) out.push(id);
	}
	return out;
}

/**
 * @param {any} entity
 * @param {string} prop
 * @returns {number | null}
 */
function claimYear(entity, prop) {
	for (const claim of entity.claims?.[prop] || []) {
		const time = claim?.mainsnak?.datavalue?.value?.time;
		if (!time) continue;
		const y = Number(String(time).replace(/^[+-]/, '').slice(0, 4));
		if (Number.isFinite(y)) return y;
	}
	return null;
}

/**
 * @param {any} entity
 * @param {string} prop
 * @returns {number | null}
 */
function claimQuantity(entity, prop) {
	for (const claim of entity.claims?.[prop] || []) {
		const amount = claim?.mainsnak?.datavalue?.value?.amount;
		if (amount == null) continue;
		const n = Number(String(amount).replace(/^\+/, ''));
		if (Number.isFinite(n)) return Math.round(n);
	}
	return null;
}

/**
 * @param {string[]} ids
 * @param {'filme' | 'serie'} tipo
 */
async function fetchCandidatesData(ids, tipo) {
	if (!ids.length) return [];
	const entities = await wbgetentities(ids);

	/** @type {Set<string>} */
	const refIds = new Set();
	for (const id of ids) {
		const ent = entities[id];
		if (!ent || ent.missing != null) continue;
		for (const prop of ['P57', 'P58', 'P161', 'P136', 'P495', 'P170', 'P449']) {
			for (const ref of claimEntityIds(ent, prop)) refIds.add(ref);
		}
	}

	const missingRefs = [...refIds].filter((id) => !entities[id]);
	/** @type {Record<string, any>} */
	let refEntities = {};
	// wbgetentities aceita até ~50 ids; fatiar
	for (let i = 0; i < missingRefs.length; i += 40) {
		const chunk = missingRefs.slice(i, i + 40);
		const got = await wbgetentities(chunk);
		refEntities = { ...refEntities, ...got };
	}
	const all = { ...entities, ...refEntities };

	/**
	 * @param {string[]} qids
	 * @param {number} [limit]
	 */
	function labelsOf(qids, limit) {
		const list = limit != null ? qids.slice(0, limit) : qids;
		return list
			.map((qid) => pickLabel(all[qid] || { id: qid }))
			.filter(Boolean);
	}

	/** @type {any[]} */
	const out = [];
	for (const id of ids) {
		const ent = entities[id];
		if (!ent || ent.missing != null) continue;

		const { rotulo, titulos, tituloOriginal } = collectTitulos(ent);
		const direcao = labelsOf(claimEntityIds(ent, 'P57'));
		const roteiro = labelsOf(claimEntityIds(ent, 'P58'));
		const elenco = labelsOf(claimEntityIds(ent, 'P161'), 6);
		const generos = labelsOf(claimEntityIds(ent, 'P136'));
		const paises = labelsOf(claimEntityIds(ent, 'P495'));
		const criadoresIds = [
			...claimEntityIds(ent, 'P170'),
			...(tipo === 'serie' ? claimEntityIds(ent, 'P58') : []),
		];
		const criadores = labelsOf([...new Set(criadoresIds)]);
		const emissoras = labelsOf(claimEntityIds(ent, 'P449'));

		out.push({
			id,
			rotulo,
			tituloOriginal,
			titulos,
			ano: claimYear(ent, 'P577'),
			anoInicio: claimYear(ent, 'P580'),
			sitelinks: Object.keys(ent.sitelinks || {}).length,
			direcao,
			roteiro,
			elenco,
			generos,
			paises,
			criadores,
			duracaoMin: claimQuantity(ent, 'P2047'),
			temporadas: claimQuantity(ent, 'P2437'),
			emissora: emissoras[0] || '',
		});
	}
	return out;
}

/**
 * @param {any} cand
 * @param {{ obra: string, title: string, anoObra: number | null, pubYear: number | null }} ctx
 */
function scoreCandidate(cand, ctx) {
	let score = 0;
	const nObra = normalize(ctx.obra);
	/** @type {string[]} */
	const titulosCasados = [];
	let tituloExato = false;

	for (const t of cand.titulos || []) {
		const nT = normalize(t);
		if (!nT || !nObra) continue;
		if (nT === nObra) {
			tituloExato = true;
			if (!titulosCasados.includes(t)) titulosCasados.push(t);
		} else if (nT.includes(nObra) || nObra.includes(nT)) {
			if (!titulosCasados.includes(t)) titulosCasados.push(t);
		}
	}

	if (tituloExato) score += 4;
	else if (titulosCasados.length) score += 1;

	const titleYear = yearFromTitle(ctx.title);
	const anosRef = [ctx.anoObra, titleYear].filter(
		(y) => y != null && Number.isFinite(y),
	);
	if (
		cand.ano != null &&
		anosRef.some((y) => y === cand.ano)
	) {
		score += 4;
	}

	if (ctx.pubYear != null && cand.ano != null) {
		if (cand.ano <= ctx.pubYear && cand.ano >= ctx.pubYear - 2) {
			score += 2;
		}
	}

	if ((cand.sitelinks || 0) >= 20) score += 1;

	return { score, titulosCasados, tituloExato };
}

/**
 * @param {any} best
 * @param {any | undefined} second
 * @param {any[]} scored
 */
function confiancaAlta(best, second, scored) {
	const margin = best.pontuacao - (second?.pontuacao ?? 0);
	if (best.pontuacao >= 6 && margin >= 2) return true;

	if (best.tituloExato && (best.sitelinks || 0) >= 10) {
		const outrosExatos = scored.filter(
			(c) => c.id !== best.id && c.tituloExato,
		);
		if (!outrosExatos.length) return true;
	}
	return false;
}

/**
 * @param {string} s
 */
function capitalizeFirst(s) {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Traduções de gêneros só em inglês → português */
const GENRE_EN_MAP = {
	'romantic comedy': 'Comédia romântica',
	drama: 'Drama',
	comedy: 'Comédia',
	thriller: 'Suspense',
	horror: 'Terror',
	'science fiction': 'Ficção científica',
	action: 'Ação',
	adventure: 'Aventura',
	documentary: 'Documentário',
	animation: 'Animação',
	fantasy: 'Fantasia',
	war: 'Guerra',
	western: 'Faroeste',
	crimes: 'Crime',
};

/**
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeGenero(raw) {
	const original = String(raw || '').trim();
	if (!original) return null;
	const fromPt =
		/^(filme de |filme sobre |série de televisão de |série de )/i.test(
			original,
		);
	let s = original
		.replace(/^(filme de |filme sobre |série de televisão de |série de )/i, '')
		.replace(/\s+film$/i, '')
		.trim();
	if (!s) return null;

	const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
	if (GENRE_EN_MAP[key]) return GENRE_EN_MAP[key];

	const looksEnglish =
		/^[a-z0-9\s'’.-]+$/i.test(s) && !/[àáâãäéêëíîïóôõöúûüç]/i.test(s);
	if (!fromPt && looksEnglish) return null;

	return capitalizeFirst(s);
}

/**
 * @param {string[]} generos
 * @returns {string[]}
 */
function normalizeGeneros(generos) {
	/** @type {string[]} */
	const out = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const g of generos || []) {
		const n = normalizeGenero(g);
		if (!n) continue;
		const k = normalize(n);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(n);
		if (out.length >= 3) break;
	}
	return out;
}

/**
 * Distância de edição (Levenshtein).
 * @param {string} a
 * @param {string} b
 */
function editDistance(a, b) {
	const m = a.length;
	const n = b.length;
	/** @type {number[]} */
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		/** @type {number[]} */
		const cur = [i];
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
		}
		prev = cur;
	}
	return prev[n];
}

/**
 * @param {string[]} nomes
 * @param {number} max
 * @returns {string[]}
 */
function dedupeNomesProximos(nomes, max) {
	/** @type {string[]} */
	const out = [];
	for (const nome of nomes || []) {
		const t = String(nome || '').trim();
		if (!t) continue;
		const nt = normalize(t);
		const near = out.some((kept) => {
			const nk = normalize(kept);
			if (nk === nt) return true;
			return editDistance(nk, nt) <= 1;
		});
		if (near) continue;
		out.push(t);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * @param {string[]} elenco
 * @returns {string[]}
 */
function normalizeElenco(elenco) {
	/** @type {string[]} */
	const out = [];
	/** @type {Set<string>} */
	const seen = new Set();
	for (const nome of elenco || []) {
		const t = String(nome || '').trim();
		if (!t) continue;
		const k = normalize(t);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(t);
		if (out.length >= 6) break;
	}
	return out;
}

/**
 * Normaliza campos da ficha antes de gravar.
 * @param {any} ficha
 */
function normalizeFicha(ficha) {
	if (ficha.generos) {
		ficha.generos = normalizeGeneros(ficha.generos);
		if (!ficha.generos.length) delete ficha.generos;
	}
	if (ficha.roteiro) {
		ficha.roteiro = dedupeNomesProximos(ficha.roteiro, 4);
		if (!ficha.roteiro.length) delete ficha.roteiro;
	}
	if (ficha.elenco) {
		ficha.elenco = normalizeElenco(ficha.elenco);
		if (!ficha.elenco.length) delete ficha.elenco;
	}
	return ficha;
}

/**
 * @param {string} s
 */
function csvEscape(s) {
	const v = String(s ?? '');
	if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
	return v;
}

/**
 * @param {any} ficha
 */
function fichaToYaml(ficha) {
	/** @type {string[]} */
	const lines = ['ficha:'];
	/**
	 * @param {string} key
	 * @param {unknown} val
	 */
	function add(key, val) {
		if (val == null || val === '') return;
		if (Array.isArray(val)) {
			if (!val.length) return;
			lines.push(`  ${key}:`);
			for (const item of val) {
				lines.push(`    - ${yamlScalar(String(item))}`);
			}
			return;
		}
		lines.push(`  ${key}: ${yamlScalar(val)}`);
	}
	add('tituloOriginal', ficha.tituloOriginal);
	add('ano', ficha.ano);
	add('direcao', ficha.direcao);
	add('roteiro', ficha.roteiro);
	add('elenco', ficha.elenco);
	add('generos', ficha.generos);
	add('duracaoMin', ficha.duracaoMin);
	add('paises', ficha.paises);
	add('criadores', ficha.criadores);
	add('temporadas', ficha.temporadas);
	add('emissora', ficha.emissora);
	add('wikidataId', ficha.wikidataId);
	return lines.join('\n');
}

/**
 * @param {unknown} v
 */
function yamlScalar(v) {
	if (typeof v === 'number') return String(v);
	const s = String(v);
	if (/^[\w.+-]+$/u.test(s) && !/^(?:true|false|null|yes|no)$/i.test(s)) {
		return s;
	}
	return JSON.stringify(s);
}

/**
 * @param {string} filePath
 * @param {any} ficha
 * @param {number | null} anoObraExistente
 */
async function applyFicha(filePath, ficha, anoObraExistente) {
	const raw = await readFile(filePath, 'utf8');
	const parts = splitFrontmatter(raw);
	if (!parts) throw new Error(`Sem frontmatter: ${filePath}`);
	if (/^ficha:/m.test(parts.fm) || /wikidataId:/m.test(parts.fm)) {
		console.log(`  skip (ficha existente): ${relative(ROOT, filePath)}`);
		return false;
	}

	let fm = parts.fm.replace(/\s+$/, '');
	fm += '\n' + fichaToYaml(ficha);

	if (
		(anoObraExistente == null || anoObraExistente === '') &&
		ficha.ano != null
	) {
		if (!/^anoObra:/m.test(fm)) {
			fm += `\nanoObra: ${ficha.ano}`;
		}
	}

	const next = `${parts.open}${fm}${parts.close}${parts.body}`;
	await writeFile(filePath, next, 'utf8');
	return true;
}

/**
 * Parse CSV simples com aspas.
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
function parseCsvWithHeaders(text) {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { headers: [], rows: [] };
	const headers = splitCsvLine(lines[0]);
	const rows = lines.slice(1).map((line) => {
		const cols = splitCsvLine(line);
		/** @type {Record<string, string>} */
		const row = {};
		headers.forEach((h, i) => {
			row[h] = cols[i] ?? '';
		});
		return row;
	});
	return { headers, rows };
}

/**
 * @param {string} text
 */
function parseCsv(text) {
	return parseCsvWithHeaders(text).rows;
}

/**
 * @param {string[]} headers
 * @param {Record<string, string>[]} rows
 */
function serializeCsv(headers, rows) {
	return (
		headers.join(',') +
		'\n' +
		rows.map((r) => headers.map((h) => csvEscape(r[h] ?? '')).join(',')).join('\n') +
		'\n'
	);
}

/**
 * Busca por termo e classes do tipo (sem simplificar o título).
 * @param {string} term
 * @param {'filme' | 'serie'} tipo
 */
async function searchByTipo(term, tipo) {
	if (tipo === 'filme') return searchByClasses(term, CLASSES_FILME);
	let ids = await searchByClass(term, CLASSE_SERIE);
	if (ids.length) return ids;
	return searchByClasses(term, [CLASSE_MINISSERIE, CLASSE_SERIE_ANIMADA]);
}

/**
 * Ano do item para segunda busca: P577 (filme); P580 ou P577 (série).
 * @param {any} cand
 * @param {'filme' | 'serie'} tipo
 */
function anoParaSegundaBusca(cand, tipo) {
	if (tipo === 'serie') {
		return cand.anoInicio ?? cand.ano ?? null;
	}
	return cand.ano ?? null;
}

/**
 * @param {string} line
 */
function splitCsvLine(line) {
	/** @type {string[]} */
	const out = [];
	let cur = '';
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (q && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else q = !q;
			continue;
		}
		if (c === ',' && !q) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	out.push(cur);
	return out;
}

async function runApply() {
	const text = await readFile(OUT_CSV, 'utf8');
	const rows = parseCsv(text);
	let applied = 0;
	let skipped = 0;
	let aprovadasVistas = 0;
	/** @type {string[]} */
	const classeInvalida = [];

	for (const row of rows) {
		if (String(row.aprovar || '').trim().toLowerCase() !== 'sim') {
			skipped++;
			continue;
		}
		if (Number.isFinite(LIMITE) && aprovadasVistas >= /** @type {number} */ (LIMITE)) {
			break;
		}
		aprovadasVistas++;
		const arquivo = row.arquivo;
		const wikidataId = String(row.wikidataId || '').trim();
		if (!arquivo || !/^Q\d+$/.test(wikidataId)) {
			skipped++;
			continue;
		}

		const abs = join(ROOT, arquivo);
		let raw;
		try {
			raw = await readFile(abs, 'utf8');
		} catch {
			console.warn(`  arquivo ausente: ${arquivo}`);
			skipped++;
			continue;
		}
		const parts = splitFrontmatter(raw);
		if (!parts) {
			skipped++;
			continue;
		}
		if (/^ficha:/m.test(parts.fm) || /wikidataId:/m.test(parts.fm)) {
			console.log(`  skip (ficha existente): ${arquivo}`);
			skipped++;
			continue;
		}

		const tipoFm = getScalar(parts.fm, 'tipo');
		const tipo =
			tipoFm === 'filme' || tipoFm === 'serie'
				? tipoFm
				: row.tipo === 'serie'
					? 'serie'
					: 'filme';

		let okClass = false;
		try {
			okClass = await entityMatchesTipo(wikidataId, tipo);
		} catch (err) {
			console.warn(
				`  validação falhou ${wikidataId}: ${err.message || err}`,
			);
			classeInvalida.push(`${arquivo} (${wikidataId}: erro na validação)`);
			continue;
		}
		if (!okClass) {
			console.warn(`  classe inválida: ${arquivo} → ${wikidataId} (tipo ${tipo})`);
			classeInvalida.push(`${arquivo} (${wikidataId})`);
			continue;
		}

		/** @type {any[]} */
		let candidates = [];
		try {
			candidates = await fetchCandidatesData([wikidataId], tipo);
		} catch (err) {
			console.warn(`  fetch falhou ${wikidataId}: ${err.message || err}`);
			skipped++;
			continue;
		}
		const cand = candidates[0];
		if (!cand) {
			console.warn(`  sem dados: ${arquivo} → ${wikidataId}`);
			skipped++;
			continue;
		}

		const ficha = normalizeFicha({
			tituloOriginal: cand.tituloOriginal || cand.rotulo || undefined,
			ano: cand.ano ?? undefined,
			direcao: cand.direcao?.length ? cand.direcao : undefined,
			roteiro: cand.roteiro?.length ? cand.roteiro : undefined,
			elenco: cand.elenco?.length ? cand.elenco : undefined,
			generos: cand.generos?.length ? cand.generos : undefined,
			duracaoMin: cand.duracaoMin ?? undefined,
			paises: cand.paises?.length ? cand.paises : undefined,
			criadores: cand.criadores?.length ? cand.criadores : undefined,
			temporadas: cand.temporadas ?? undefined,
			emissora: cand.emissora || undefined,
			wikidataId: cand.id,
		});
		for (const k of Object.keys(ficha)) {
			const v = ficha[k];
			if (v == null || v === '' || (Array.isArray(v) && !v.length)) {
				delete ficha[k];
			}
		}

		const anoObraRaw = getScalar(parts.fm, 'anoObra');
		const anoObra = anoObraRaw ? Number(anoObraRaw) : null;
		const ok = await applyFicha(
			abs,
			ficha,
			Number.isFinite(anoObra) ? anoObra : null,
		);
		if (ok) {
			applied++;
			console.log(`  ok ${arquivo} → ${wikidataId}`);
		} else {
			skipped++;
		}
	}

	console.log(`\n--apply: ${applied} fichas gravadas, ${skipped} ignoradas.`);
	if (classeInvalida.length) {
		console.log(`classe inválida (${classeInvalida.length}):`);
		for (const line of classeInvalida) console.log(`  - ${line}`);
	}
}

/**
 * Confere P31/P279* contra a classe esperada do tipo.
 * @param {string} id
 * @param {'filme' | 'serie'} tipo
 */
async function entityMatchesTipo(id, tipo) {
	const classes = tipo === 'filme' ? CLASSES_FILME : CLASSES_SERIE;
	const values = classes.map((c) => `wd:${c}`).join(' ');
	const query = `ASK { VALUES ?class { ${values} } wd:${id} wdt:P31/wdt:P279* ?class . }`;
	const params = new URLSearchParams({ query, format: 'json' });
	const res = await fetchRetry(`${SPARQL_URL}?${params}`, {
		headers: { Accept: 'application/sparql-results+json' },
	});
	await sleep(DELAY_MS);
	const data = await res.json();
	return Boolean(data.boolean);
}

/** Linha vazia padrão para CSV */
function emptyRow(rel, obra, tipo) {
	return {
		arquivo: rel,
		obra,
		tipo,
		wikidataId: '',
		rotulo: '',
		ano: '',
		direcao: '',
		confianca: 'baixa',
		pontuacao: '0',
		segundo_candidato: '',
		aprovar: '',
		titulos_casados: '',
		ano_item: '',
		sitelinks: '',
		url: '',
		tituloOriginal: '',
		roteiro: '',
		elenco: '',
		generos: '',
		duracaoMin: '',
		paises: '',
		criadores: '',
		temporadas: '',
		emissora: '',
	};
}

async function runSearch() {
	const files = await walkMd(RESENHAS);
	/** @type {any[]} */
	const rows = [];

	let alta = 0;
	let baixa = 0;
	let sem = 0;

	for (const file of files) {
		const raw = await readFile(file, 'utf8');
		const parts = splitFrontmatter(raw);
		if (!parts) continue;
		const tipo = getScalar(parts.fm, 'tipo');
		if (tipo !== 'filme' && tipo !== 'serie') continue;
		if (/wikidataId:/.test(parts.fm)) continue;

		const obra = getScalar(parts.fm, 'obra') || getScalar(parts.fm, 'title');
		const title = getScalar(parts.fm, 'title');
		const anoObraRaw = getScalar(parts.fm, 'anoObra');
		const anoObra = anoObraRaw ? Number(anoObraRaw) : null;
		const pubDate = getScalar(parts.fm, 'pubDate');
		const pubYear = pubDate ? Number(pubDate.slice(0, 4)) : null;
		const rel = relative(ROOT, file).replace(/\\/g, '/');

		console.log(`→ ${rel} (${obra})`);

		/** @type {string[]} */
		let ids = [];
		try {
			ids = await searchIds(obra, /** @type {'filme'|'serie'} */ (tipo));
		} catch (err) {
			console.warn(`  busca falhou: ${err.message || err}`);
		}

		let candidates = [];
		try {
			candidates = await fetchCandidatesData(
				ids,
				/** @type {'filme'|'serie'} */ (tipo),
			);
		} catch (err) {
			console.warn(`  sparql falhou: ${err.message || err}`);
		}

		const ctx = {
			obra,
			title,
			anoObra: Number.isFinite(anoObra) ? anoObra : null,
			pubYear: Number.isFinite(pubYear) ? pubYear : null,
		};

		const scored = candidates
			.map((c) => {
				const { score, titulosCasados, tituloExato } = scoreCandidate(c, ctx);
				return {
					...c,
					pontuacao: score,
					titulosCasados,
					tituloExato,
				};
			})
			.sort(
				(a, b) =>
					b.pontuacao - a.pontuacao ||
					(b.sitelinks || 0) - (a.sitelinks || 0) ||
					ids.indexOf(a.id) - ids.indexOf(b.id),
			);

		if (!scored.length) {
			sem++;
			rows.push(emptyRow(rel, obra, tipo));
			console.log('  sem candidato');
			continue;
		}

		const best = scored[0];
		const second = scored[1];
		const confianca = confiancaAlta(best, second, scored) ? 'alta' : 'baixa';

		if (confianca === 'alta') alta++;
		else baixa++;

		const segundoStr = second
			? `${second.id} ${second.rotulo}`.trim()
			: '';

		rows.push({
			arquivo: rel,
			obra,
			tipo,
			wikidataId: best.id,
			rotulo: best.rotulo,
			ano: best.ano ?? '',
			direcao: best.direcao.join(', '),
			confianca,
			pontuacao: String(best.pontuacao),
			segundo_candidato: segundoStr,
			aprovar: confianca === 'alta' ? 'sim' : '',
			titulos_casados: best.titulosCasados.join(' | '),
			ano_item: best.ano ?? '',
			sitelinks: best.sitelinks ?? '',
			url: `https://www.wikidata.org/wiki/${best.id}`,
			tituloOriginal: best.tituloOriginal || best.rotulo,
			roteiro: best.roteiro.join(', '),
			elenco: best.elenco.join(', '),
			generos: best.generos.join(', '),
			duracaoMin: best.duracaoMin ?? '',
			paises: best.paises.join(', '),
			criadores: best.criadores.join(', '),
			temporadas: best.temporadas ?? '',
			emissora: best.emissora || '',
		});

		console.log(
			`  ${best.id} “${best.rotulo}” pts=${best.pontuacao} conf=${confianca} sl=${best.sitelinks}`,
		);
	}

	const headers = [
		'arquivo',
		'obra',
		'tipo',
		'wikidataId',
		'rotulo',
		'ano',
		'direcao',
		'confianca',
		'pontuacao',
		'segundo_candidato',
		'aprovar',
		'titulos_casados',
		'ano_item',
		'sitelinks',
		'url',
		'tituloOriginal',
		'roteiro',
		'elenco',
		'generos',
		'duracaoMin',
		'paises',
		'criadores',
		'temporadas',
		'emissora',
	];

	const csv =
		headers.join(',') +
		'\n' +
		rows
			.map((r) => headers.map((h) => csvEscape(r[h])).join(','))
			.join('\n') +
		'\n';

	await mkdir(dirname(OUT_CSV), { recursive: true });
	await writeFile(OUT_CSV, csv, 'utf8');

	console.log('\n=== Resumo ===');
	console.log(`total: ${rows.length}`);
	console.log(`alta: ${alta}`);
	console.log(`baixa: ${baixa}`);
	console.log(`sem candidato: ${sem}`);
	console.log(`CSV: ${relative(ROOT, OUT_CSV)}`);
}

/**
 * Segunda busca: só CSV, linhas com titulo_busca e aprovar vazio.
 */
async function runSegundaBusca() {
	const text = await readFile(OUT_CSV, 'utf8');
	const { headers, rows } = parseCsvWithHeaders(text);
	for (const col of ['titulo_busca', 'ano_busca', 'observacao']) {
		if (!headers.includes(col)) headers.push(col);
	}

	let resolvidas = 0;
	/** @type {{ arquivo: string, motivo: string }[]} */
	const naoResolvidas = [];

	for (const row of rows) {
		const tituloBusca = String(row.titulo_busca || '').trim();
		const aprovar = String(row.aprovar || '').trim();
		if (!tituloBusca || aprovar) continue;

		const tipo = row.tipo === 'serie' ? 'serie' : 'filme';
		const anoBusca = Number(String(row.ano_busca || '').trim());
		const rel = row.arquivo || '';

		console.log(`→ ${rel} (“${tituloBusca}” ${row.ano_busca || '?'})`);

		if (!Number.isFinite(anoBusca)) {
			row.observacao = 'ano_busca ausente ou inválido';
			naoResolvidas.push({ arquivo: rel, motivo: row.observacao });
			console.log(`  ${row.observacao}`);
			continue;
		}

		/** @type {string[]} */
		let ids = [];
		try {
			ids = await searchByTipo(tituloBusca, tipo);
		} catch (err) {
			row.observacao = `busca falhou: ${err.message || err}`;
			naoResolvidas.push({ arquivo: rel, motivo: row.observacao });
			console.log(`  ${row.observacao}`);
			continue;
		}

		if (!ids.length) {
			row.observacao = 'nenhum resultado na busca textual';
			naoResolvidas.push({ arquivo: rel, motivo: row.observacao });
			console.log(`  ${row.observacao}`);
			continue;
		}

		/** @type {any[]} */
		let candidates = [];
		try {
			candidates = await fetchCandidatesData(ids, tipo);
		} catch (err) {
			row.observacao = `fetch falhou: ${err.message || err}`;
			naoResolvidas.push({ arquivo: rel, motivo: row.observacao });
			console.log(`  ${row.observacao}`);
			continue;
		}

		const nBusca = normalize(tituloBusca);
		const passed = candidates.filter((c) => {
			const tituloOk = (c.titulos || []).some(
				(t) => normalize(t) === nBusca,
			);
			if (!tituloOk) return false;
			const anoItem = anoParaSegundaBusca(c, tipo);
			if (anoItem == null) return false;
			return anoItem >= anoBusca - 1 && anoItem <= anoBusca;
		});

		if (passed.length === 1) {
			const best = passed[0];
			const anoItem = anoParaSegundaBusca(best, tipo);
			row.wikidataId = best.id;
			row.rotulo = best.rotulo || '';
			row.ano_item = anoItem != null ? String(anoItem) : '';
			row.ano = row.ano_item;
			row.aprovar = 'sim';
			row.confianca = 'manual';
			row.url = `https://www.wikidata.org/wiki/${best.id}`;
			row.observacao = '';
			resolvidas++;
			console.log(`  ok ${best.id} “${best.rotulo}” (${anoItem})`);
			continue;
		}

		if (passed.length === 0) {
			row.observacao =
				'nenhum candidato com título exato e ano em [ano_busca-1, ano_busca]';
		} else {
			row.observacao = `múltiplos candidatos: ${passed
				.map((c) => c.id)
				.join(', ')}`;
		}
		naoResolvidas.push({ arquivo: rel, motivo: row.observacao });
		console.log(`  ${row.observacao}`);
	}

	await writeFile(OUT_CSV, serializeCsv(headers, rows), 'utf8');

	console.log('\n=== Resumo segunda-busca ===');
	console.log(`resolvidas: ${resolvidas}`);
	console.log(`não resolvidas: ${naoResolvidas.length}`);
	if (naoResolvidas.length) {
		console.log('lista:');
		for (const item of naoResolvidas) {
			console.log(`  - ${item.arquivo}: ${item.motivo}`);
		}
	}
}

async function main() {
	if (SEGUNDA_BUSCA) {
		await runSegundaBusca();
		return;
	}
	if (APPLY) {
		await runApply();
		return;
	}
	await runSearch();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
