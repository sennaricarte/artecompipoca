#!/usr/bin/env node
/**
 * Inventário read-only de URLs HTML no Wayback Machine (artecompipoca.net).
 * Sem flags: só imprime resumo. Com --apply: grava _recuperados/inventario.csv.
 * Opcional: --ate=AAAA escolhe o snapshot mais recente com ano <= AAAA.
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RECUPERADOS = join(ROOT, '_recuperados');
const INVENTARIO_CSV = join(RECUPERADOS, 'inventario.csv');
const SEMRUSH_CSV = join(RECUPERADOS, 'semrush-backlinks.csv');

// Sem collapse=urlkey: precisamos de todos os timestamps por URL para histograma e --ate.
const CDX_URL =
	'https://web.archive.org/cdx/search/cdx?url=artecompipoca.net/*&output=json&fl=original,timestamp,statuscode,mimetype&filter=statuscode:200&filter=mimetype:text/html';

const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const APPLY = process.argv.includes('--apply');
const ATE_YEAR = parseAteYear(process.argv);

const DISCARD_PATH_MARKERS = [
	'/wp-content/',
	'/wp-includes/',
	'/wp-admin/',
	'/wp-json/',
	'/feed/',
	'/tag/',
	'/author/',
	'/attachment/',
	'/trackback/',
	'/comment-page-',
];

const SPAM_TERMS_RE =
	/(^|[^a-z0-9])(casino|slot|bet|viagra|loan|crypto|porn|replica|pharmacy)([^a-z0-9]|$)/i;

/**
 * @param {string[]} argv
 * @returns {number | null}
 */
function parseAteYear(argv) {
	const arg = argv.find((a) => a.startsWith('--ate='));
	if (!arg) return null;
	const year = Number.parseInt(arg.slice('--ate='.length), 10);
	if (!Number.isFinite(year) || year < 1990 || year > 2100) {
		throw new Error(`Valor inválido para --ate (use --ate=AAAA): ${arg}`);
	}
	return year;
}

/**
 * @param {string} url
 * @param {number} [attempts]
 * @returns {Promise<unknown>}
 */
async function fetchJsonWithRetry(url, attempts = MAX_ATTEMPTS) {
	let lastError;
	for (let i = 0; i < attempts; i++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: controller.signal });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status} ${res.statusText}`);
			}
			return await res.json();
		} catch (err) {
			lastError = err;
			if (i < attempts - 1) {
				const delayMs = 1000 * 2 ** i;
				console.warn(
					`  Tentativa ${i + 1}/${attempts} falhou (${err instanceof Error ? err.message : err}). Retry em ${delayMs}ms…`,
				);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastError;
}

/**
 * @param {string} raw
 * @returns {string | null}
 */
function normalizeUrl(raw) {
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}

	parsed.protocol = 'https:';
	parsed.hostname = parsed.hostname.replace(/^www\./i, '');
	parsed.search = '';
	parsed.hash = '';

	let path = parsed.pathname.replace(/^\/index\.php(?=\/|$)/i, '') || '/';
	if (!path.startsWith('/')) path = `/${path}`;
	if (!path.endsWith('/')) path += '/';
	parsed.pathname = path;

	return parsed.href;
}

/**
 * @param {string} originalUrl
 * @returns {boolean}
 */
function shouldDiscard(originalUrl) {
	let parsed;
	try {
		parsed = new URL(originalUrl);
	} catch {
		return true;
	}

	const path = parsed.pathname;
	const pathLower = path.toLowerCase();
	const searchLower = parsed.search.toLowerCase();

	for (const marker of DISCARD_PATH_MARKERS) {
		if (pathLower.includes(marker)) return true;
	}

	if (/\/page\/\d+\/?/i.test(path)) return true;

	if (/(?:^|[?&])p=/i.test(searchLower)) return true;
	if (/(?:^|[?&])replytocom=/i.test(searchLower)) return true;

	const pathNoSlash = path.replace(/\/+$/, '');
	if (/\.[a-z0-9]{1,5}$/i.test(pathNoSlash)) return true;

	if (/^\/\d{4}\/?$/i.test(path)) return true;
	if (/^\/\d{4}\/\d{2}\/?$/i.test(path)) return true;

	return false;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function hasNonLatinLetters(text) {
	for (const ch of text) {
		if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) {
			return true;
		}
	}
	return false;
}

/**
 * @param {string} pathRaw
 * @returns {string}
 */
function decodePath(pathRaw) {
	try {
		return decodeURIComponent(pathRaw);
	} catch {
		return pathRaw;
	}
}

/**
 * @param {string} normalizedHref
 * @returns {boolean}
 */
function isSpam(normalizedHref) {
	const pathDecoded = decodePath(new URL(normalizedHref).pathname);
	if (hasNonLatinLetters(pathDecoded)) return true;
	if (SPAM_TERMS_RE.test(pathDecoded.toLowerCase())) return true;
	return false;
}

/**
 * Spam primeiro; depois classificação por slug.
 * @param {string} normalizedHref
 * @returns {string}
 */
function classifyTipo(normalizedHref) {
	if (isSpam(normalizedHref)) return 'spam';

	const path = new URL(normalizedHref).pathname.toLowerCase();

	if (path.startsWith('/category/')) return 'categoria';
	if (path.startsWith('/oblogquenaoestavala/')) return 'subblog';

	if (/-critica|-resenha|-review/.test(path)) return 'resenha';

	const firstSegment = path.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
	if (firstSegment.startsWith('top-') || /melhores-|piores-|lista-/.test(path)) {
		return 'lista';
	}

	if (/pipocacast|balde-cheio|balde-vazio|sete-reinos|na-mesa/.test(path)) {
		return 'podcast';
	}

	if (/trailer|poster|cartaz|teaser|estreia|-veja-/.test(path)) return 'noticia';

	return 'outro';
}

/**
 * @param {string} timestamp YYYYMMDDhhmmss
 * @returns {string} AAAA-MM-DD
 */
function timestampToDate(timestamp) {
	return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`;
}

/**
 * @param {string} timestamp
 * @returns {number}
 */
function timestampYear(timestamp) {
	return Number.parseInt(timestamp.slice(0, 4), 10);
}

/**
 * @returns {Promise<{ original: string, timestamp: string }[]>}
 */
async function fetchCdx() {
	console.log('Consultando CDX: artecompipoca.net/*');
	const data = await fetchJsonWithRetry(CDX_URL);
	if (!Array.isArray(data) || data.length === 0) return [];

	const [header, ...rows] = data;
	const originalIdx = header.indexOf('original');
	const timestampIdx = header.indexOf('timestamp');
	if (originalIdx < 0 || timestampIdx < 0) {
		throw new Error(`Cabeçalho CDX inesperado: ${JSON.stringify(header)}`);
	}

	return rows.map((row) => ({
		original: String(row[originalIdx]),
		timestamp: String(row[timestampIdx]),
	}));
}

/**
 * @returns {Promise<Set<string>>}
 */
async function loadBacklinkNormalizedUrls() {
	const set = new Set();
	try {
		await access(SEMRUSH_CSV);
	} catch {
		console.log('Semrush: arquivo _recuperados/semrush-backlinks.csv não encontrado (ok).');
		return set;
	}

	const text = await readFile(SEMRUSH_CSV, 'utf8');
	const re = /(?:www\.)?artecompipoca\.net(\/[^\s"'<>]+)/gi;
	let match;
	let rawHits = 0;
	while ((match = re.exec(text)) !== null) {
		rawHits += 1;
		const candidate = `https://artecompipoca.net${match[1]}`;
		const norm = normalizeUrl(candidate);
		if (norm) set.add(norm);
	}
	console.log(`Semrush: ${rawHits} ocorrência(s) bruta(s), ${set.size} URL(s) normalizada(s).`);
	return set;
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
 * @param {Record<number, number>} counts
 * @param {string} title
 * @param {number} [maxBar]
 */
function printHistogram(counts, title, maxBar = 40) {
	const years = Object.keys(counts)
		.map(Number)
		.sort((a, b) => a - b);
	console.log(title);
	if (years.length === 0) {
		console.log('  (vazio)');
		return;
	}
	const max = Math.max(...years.map((y) => counts[y]));
	for (const year of years) {
		const n = counts[year];
		const barLen = max === 0 ? 0 : Math.max(0, Math.round((n / max) * maxBar));
		console.log(`${year}: ${n} ${'█'.repeat(barLen)}`);
	}
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
 * @param {{
 *   url_normalizada: string,
 *   url_original: string,
 *   tipo_provavel: string,
 *   primeiro_snapshot: string,
 *   ultimo_snapshot: string,
 *   total_snapshots: number,
 *   tem_backlink: string,
 *   timestamp: string,
 *   wayback_url: string,
 *   aprovar: string,
 * }[]} rows
 */
async function writeInventarioCsv(rows) {
	await mkdir(RECUPERADOS, { recursive: true });
	const header = [
		'url_normalizada',
		'url_original',
		'tipo_provavel',
		'primeiro_snapshot',
		'ultimo_snapshot',
		'total_snapshots',
		'tem_backlink',
		'timestamp',
		'wayback_url',
		'aprovar',
	];
	const lines = [
		header.join(','),
		...rows.map((r) =>
			[
				r.url_normalizada,
				r.url_original,
				r.tipo_provavel,
				r.primeiro_snapshot,
				r.ultimo_snapshot,
				r.total_snapshots,
				r.tem_backlink,
				r.timestamp,
				r.wayback_url,
				r.aprovar,
			]
				.map(csvEscape)
				.join(','),
		),
	];
	const bom = '\uFEFF';
	await writeFile(INVENTARIO_CSV, bom + lines.join('\n') + '\n', 'utf8');
	console.log(`CSV gravado: ${INVENTARIO_CSV}`);
}

/**
 * @param {string[]} timestamps sorted ascending
 * @param {number | null} ateYear
 * @returns {string | null}
 */
function pickSnapshotTimestamp(timestamps, ateYear) {
	if (timestamps.length === 0) return null;
	if (ateYear == null) return timestamps[timestamps.length - 1];
	const eligible = timestamps.filter((ts) => timestampYear(ts) <= ateYear);
	if (eligible.length === 0) return null;
	return eligible[eligible.length - 1];
}

async function main() {
	const cdxRows = await fetchCdx();
	console.log(`  → ${cdxRows.length} registro(s)`);

	const totalBruto = cdxRows.length;
	let descartados = 0;

	/** @type {Map<string, { original: string, timestamp: string }[]>} */
	const byNormalized = new Map();

	for (const row of cdxRows) {
		if (shouldDiscard(row.original)) {
			descartados += 1;
			continue;
		}
		const norm = normalizeUrl(row.original);
		if (!norm) {
			descartados += 1;
			continue;
		}
		const list = byNormalized.get(norm);
		if (list) {
			list.push(row);
		} else {
			byNormalized.set(norm, [row]);
		}
	}

	const backlinks = await loadBacklinkNormalizedUrls();

	/** @type {Record<number, number>} */
	const snapshotsPorAno = {};
	/** @type {Record<number, number>} */
	const urlsPorPrimeiroAno = {};

	const inventario = [...byNormalized.entries()].map(([url_normalizada, captures]) => {
		const timestamps = [...new Set(captures.map((c) => c.timestamp))].sort();
		const primeiroTs = timestamps[0];
		const ultimoTs = timestamps[timestamps.length - 1];
		const primeiro_snapshot = timestampToDate(primeiroTs);
		const ultimo_snapshot = timestampToDate(ultimoTs);
		const total_snapshots = timestamps.length;

		for (const ts of timestamps) {
			const y = timestampYear(ts);
			snapshotsPorAno[y] = (snapshotsPorAno[y] ?? 0) + 1;
		}
		const firstYear = timestampYear(primeiroTs);
		urlsPorPrimeiroAno[firstYear] = (urlsPorPrimeiroAno[firstYear] ?? 0) + 1;

		const chosenTs = pickSnapshotTimestamp(timestamps, ATE_YEAR);
		const chosenCapture = chosenTs
			? (captures.find((c) => c.timestamp === chosenTs) ?? captures[captures.length - 1])
			: null;

		let tipo_provavel;
		let timestamp = '';
		let wayback_url = '';
		let url_original = captures[captures.length - 1].original;

		if (ATE_YEAR != null && chosenTs == null) {
			tipo_provavel = 'pos-expiracao';
		} else {
			tipo_provavel = classifyTipo(url_normalizada);
			timestamp = /** @type {string} */ (chosenTs);
			url_original = chosenCapture?.original ?? url_original;
			wayback_url = `https://web.archive.org/web/${timestamp}id_/${url_original}`;
		}

		return {
			url_normalizada,
			url_original,
			tipo_provavel,
			primeiro_snapshot,
			ultimo_snapshot,
			total_snapshots,
			tem_backlink: backlinks.has(url_normalizada) ? 'sim' : 'nao',
			timestamp,
			wayback_url,
			aprovar: '',
		};
	});

	inventario.sort((a, b) => {
		if (a.tem_backlink !== b.tem_backlink) {
			return a.tem_backlink === 'sim' ? -1 : 1;
		}
		return a.tipo_provavel.localeCompare(b.tipo_provavel, 'pt-BR');
	});

	/** @type {Record<string, number>} */
	const porTipo = {};
	let comBacklink = 0;
	for (const row of inventario) {
		porTipo[row.tipo_provavel] = (porTipo[row.tipo_provavel] ?? 0) + 1;
		if (row.tem_backlink === 'sim') comBacklink += 1;
	}

	console.log('\n=== Resumo inventário Wayback ===');
	if (ATE_YEAR != null) {
		console.log(`Corte --ate=${ATE_YEAR}: snapshot mais recente com ano <= ${ATE_YEAR}`);
	} else {
		console.warn(
			'AVISO: sem --ate, o snapshot usado é o mais recente e pode ser uma página de domínio expirado (parked/spam).',
		);
	}
	console.log(`Total bruto CDX:          ${totalBruto}`);
	console.log(`Total após normalização:  ${inventario.length}`);
	console.log(`Descartados:              ${descartados}`);
	console.log('Por tipo_provavel:');
	for (const tipo of Object.keys(porTipo).sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
		console.log(`  ${tipo}: ${porTipo[tipo]}`);
	}
	console.log(`Com backlink (semrush):   ${comBacklink}`);

	console.log('');
	printHistogram(snapshotsPorAno, 'Histograma de snapshots por ano (todos os timestamps aceitos):');
	console.log('');
	printHistogram(urlsPorPrimeiroAno, 'Histograma de URLs por ano do primeiro_snapshot:');

	const outros = inventario.filter((r) => r.tipo_provavel === 'outro');
	const amostra = sampleRandom(outros, 40);
	console.log(`\nAmostra aleatória de ${amostra.length} URL(s) tipo "outro" (caminho + primeiro_snapshot):`);
	if (amostra.length === 0) {
		console.log('  (nenhuma)');
	} else {
		for (const row of amostra) {
			const path = new URL(row.url_normalizada).pathname;
			console.log(`  ${path}  ${row.primeiro_snapshot}`);
		}
	}

	if (APPLY) {
		await writeInventarioCsv(inventario);
	} else {
		console.log('\nModo read-only (sem --apply). CSV não foi gravado.');
		console.log('Para gravar: pnpm wayback:inventario --apply');
		console.log('Com corte: pnpm wayback:inventario --ate=AAAA --apply');
	}
}

main().catch((err) => {
	console.error('Falha no inventário Wayback:', err);
	process.exitCode = 1;
});
