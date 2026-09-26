#!/usr/bin/env node
/**
 * Baixa HTML original dos snapshots do Wayback (cache local offline).
 * Read-only por padrão. Com --apply: grava em _recuperados/html/.
 * Flags: --incluir-noticias, --limite=N
 */

import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheFileName } from './lib/nome-cache.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RECUPERADOS = join(ROOT, '_recuperados');
const INVENTARIO_CSV = join(RECUPERADOS, 'inventario.csv');
const HTML_DIR = join(RECUPERADOS, 'html');
const ERROS_CSV = join(RECUPERADOS, 'erros-download.csv');

const APPLY = process.argv.includes('--apply');
const INCLUIR_NOTICIAS = process.argv.includes('--incluir-noticias');
const LIMITE = parseLimite(process.argv);

const EXCLUIDOS = new Set(['spam', 'pos-expiracao', 'categoria']);
const MIN_CACHE_BYTES = 1024;
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1500;
const JITTER_MS = 500;
const RETRY_WAIT_MS = 60_000;
const PROGRESS_EVERY = 25;
const ESTIMATE_SEC_PER_URL = 2;

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
 * Parse CSV com aspas e UTF-8 BOM.
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
 * @param {string} msLabel
 * @returns {Promise<void>}
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @returns {number}
 */
function politeDelayMs() {
	return BASE_DELAY_MS + Math.floor(Math.random() * (JITTER_MS + 1));
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatEta(seconds) {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, '0')}`;
	if (m > 0) return `${m}m${String(sec).padStart(2, '0')}s`;
	return `${sec}s`;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function isCached(path) {
	try {
		const info = await stat(path);
		return info.isFile() && info.size > MIN_CACHE_BYTES;
	} catch {
		return false;
	}
}

/**
 * @param {Buffer} body
 * @returns {boolean}
 */
function isValidContent(body) {
	// ASCII search via latin1 — não altera o Buffer salvo
	const sample = body.toString('latin1');
	const lower = sample.toLowerCase();
	return lower.includes('wp-content') || lower.includes('artecompipoca');
}

/**
 * @param {string} waybackUrl
 * @returns {Promise<{ ok: true, body: Buffer, status: number } | { ok: false, motivo: string, status: number | '' }>}
 */
async function downloadOnce(waybackUrl) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(waybackUrl, {
			signal: controller.signal,
			redirect: 'follow',
		});
		const status = res.status;

		if (status === 429 || status >= 500) {
			return { ok: false, motivo: `http_${status}`, status };
		}
		if (!res.ok) {
			return { ok: false, motivo: `http_${status}`, status };
		}

		const ab = await res.arrayBuffer();
		const body = Buffer.from(ab);
		return { ok: true, body, status };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const motivo = /abort/i.test(msg) ? 'timeout' : `rede: ${msg}`;
		return { ok: false, motivo, status: '' };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * @param {string} waybackUrl
 * @returns {Promise<{ ok: true, body: Buffer, status: number } | { ok: false, motivo: string, status: number | '' }>}
 */
async function downloadWithRetry(waybackUrl) {
	/** @type {{ ok: false, motivo: string, status: number | '' }} */
	let lastFail = { ok: false, motivo: 'desconhecido', status: '' };

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const result = await downloadOnce(waybackUrl);
		if (result.ok) return result;

		lastFail = result;
		const retryable =
			result.status === 429 ||
			(typeof result.status === 'number' && result.status >= 500);

		if (!retryable || attempt === MAX_ATTEMPTS) break;

		console.warn(
			`  Retry ${attempt}/${MAX_ATTEMPTS} após ${result.motivo}; aguardando ${RETRY_WAIT_MS / 1000}s…`,
		);
		await sleep(RETRY_WAIT_MS);
	}

	return lastFail;
}

/**
 * @param {string} urlNormalizada
 * @param {string} waybackUrl
 * @param {string} motivo
 * @param {number | ''} statusHttp
 */
async function appendErro(urlNormalizada, waybackUrl, motivo, statusHttp) {
	let needsHeader = false;
	try {
		await stat(ERROS_CSV);
	} catch {
		needsHeader = true;
	}

	const escape = (v) => {
		const s = String(v ?? '');
		if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
		return s;
	};

	const line = [urlNormalizada, waybackUrl, motivo, statusHttp]
		.map(escape)
		.join(',');

	if (needsHeader) {
		await mkdir(RECUPERADOS, { recursive: true });
		await writeFile(
			ERROS_CSV,
			'\uFEFF' + 'url_normalizada,wayback_url,motivo,status_http\n' + line + '\n',
			'utf8',
		);
	} else {
		await appendFile(ERROS_CSV, line + '\n', 'utf8');
	}
}

async function main() {
	let csvText;
	try {
		csvText = await readFile(INVENTARIO_CSV, 'utf8');
	} catch {
		console.error(`Arquivo não encontrado: ${INVENTARIO_CSV}`);
		console.error('Rode antes: pnpm wayback:inventario --apply');
		process.exitCode = 1;
		return;
	}

	const rows = parseCsv(csvText);

	/** @type {Record<string, string>[]} */
	let candidates = rows.filter((r) => {
		const tipo = (r.tipo_provavel || '').trim();
		const wayback = (r.wayback_url || '').trim();
		if (!wayback) return false;
		if (EXCLUIDOS.has(tipo)) return false;
		if (tipo === 'noticia' && !INCLUIR_NOTICIAS) return false;
		return true;
	});

	if (LIMITE != null) {
		candidates = candidates.slice(0, LIMITE);
	}

	/** @type {Record<string, number>} */
	const porTipo = {};
	let jaEmCache = 0;

	for (const row of candidates) {
		const tipo = row.tipo_provavel || 'outro';
		porTipo[tipo] = (porTipo[tipo] ?? 0) + 1;
		const dest = join(HTML_DIR, cacheFileName(row.url_normalizada));
		if (await isCached(dest)) jaEmCache += 1;
	}

	const aBaixar = candidates.length - jaEmCache;
	const etaSec = aBaixar * ESTIMATE_SEC_PER_URL;

	console.log('=== Wayback baixar (cache HTML) ===');
	console.log(`Candidatas:     ${candidates.length}`);
	console.log(`Já em cache:    ${jaEmCache}`);
	console.log(`A baixar:       ${aBaixar}`);
	console.log(`Tempo estimado: ~${formatEta(etaSec)} (${ESTIMATE_SEC_PER_URL}s/URL)`);
	console.log('Por tipo_provavel:');
	for (const tipo of Object.keys(porTipo).sort((a, b) => a.localeCompare(b, 'pt-BR'))) {
		console.log(`  ${tipo}: ${porTipo[tipo]}`);
	}
	if (!INCLUIR_NOTICIAS) {
		console.log('(notícias excluídas; use --incluir-noticias para incluí-las)');
	}

	if (!APPLY) {
		console.log('\nModo read-only (sem --apply). Nada foi baixado.');
		console.log('Para baixar: pnpm wayback:baixar --apply');
		console.log('Teste: pnpm wayback:baixar --limite=10 --apply');
		return;
	}

	await mkdir(HTML_DIR, { recursive: true });

	let ok = 0;
	let pulados = 0;
	let falhas = 0;
	const total = candidates.length;
	const started = Date.now();

	for (let i = 0; i < candidates.length; i++) {
		const row = candidates[i];
		const n = i + 1;
		const dest = join(HTML_DIR, cacheFileName(row.url_normalizada));
		const waybackUrl = row.wayback_url.trim();
		const urlNorm = row.url_normalizada;

		if (await isCached(dest)) {
			pulados += 1;
		} else {
			const result = await downloadWithRetry(waybackUrl);

			if (!result.ok) {
				falhas += 1;
				await appendErro(urlNorm, waybackUrl, result.motivo, result.status);
			} else if (!isValidContent(result.body)) {
				falhas += 1;
				await appendErro(urlNorm, waybackUrl, 'conteudo_invalido', result.status);
			} else {
				await writeFile(dest, result.body);
				ok += 1;
			}

			if (i < candidates.length - 1) {
				await sleep(politeDelayMs());
			}
		}

		if (n % PROGRESS_EVERY === 0 || n === total) {
			const doneWork = ok + falhas;
			const remaining = Math.max(0, aBaixar - doneWork);
			const elapsedSec = (Date.now() - started) / 1000;
			const rate = doneWork > 0 ? elapsedSec / doneWork : ESTIMATE_SEC_PER_URL;
			const eta = formatEta(remaining * rate);
			console.log(
				`[${n}/${total}] ok: ${ok} | pulados: ${pulados} | falhas: ${falhas} | ETA ${eta}`,
			);
		}
	}

	console.log('\nConcluído.');
	console.log(`ok: ${ok} | pulados: ${pulados} | falhas: ${falhas}`);
	if (falhas > 0) console.log(`Erros em: ${ERROS_CSV}`);
}

main().catch((err) => {
	console.error('Falha no download Wayback:', err);
	process.exitCode = 1;
});
