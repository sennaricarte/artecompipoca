#!/usr/bin/env node
/**
 * Copia Markdown de um lote em quarentena para as coleções do site.
 * Read-only por padrão. Com --apply: copia arquivos e atualiza autores.json.
 * Uso: pnpm wayback:promover --lote=N [--apply]
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugifyTitulo } from './lib/slug.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RECUPERADOS = join(ROOT, '_recuperados');
const INVENTARIO_CSV = join(RECUPERADOS, 'inventario.csv');
const AUTORES_SUGERIDOS = join(RECUPERADOS, 'autores-sugeridos.json');
const AUTORES_SITE = join(ROOT, 'src', 'data', 'autores.json');
const DEST_ARTIGOS = join(ROOT, 'src', 'content', 'artigos');
const DEST_RESENHAS = join(ROOT, 'src', 'content', 'resenhas');

const CONFERIR_PUBDATE =
	'<!-- CONFERIR: pubDate aproximada pelo primeiro snapshot do Wayback -->';

const APPLY = process.argv.includes('--apply');
const LOTE = parseLote(process.argv);

/**
 * @param {string[]} argv
 * @returns {number}
 */
function parseLote(argv) {
	const arg = argv.find((a) => a.startsWith('--lote='));
	if (!arg) {
		throw new Error(
			'Informe o lote: pnpm wayback:promover --lote=1 [--apply]',
		);
	}
	const n = Number.parseInt(arg.slice('--lote='.length), 10);
	if (!Number.isFinite(n) || n < 1) {
		throw new Error(`Valor inválido para --lote: ${arg}`);
	}
	return n;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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
 * Normaliza path de legacyUrl / URL para chave de lookup.
 * @param {string} raw
 * @returns {string}
 */
function normalizeLegacyPath(raw) {
	let path = (raw || '').trim();
	if (!path) return '';
	try {
		if (/^https?:\/\//i.test(path)) {
			path = new URL(path).pathname;
		}
	} catch {
		/* keep path */
	}
	if (!path.startsWith('/')) path = `/${path}`;
	if (!path.endsWith('/')) path += '/';
	return path.toLowerCase();
}

/**
 * @param {string} markdown
 * @returns {string}
 */
function extractLegacyUrl(markdown) {
	const m = markdown.match(/^legacyUrl:\s*["']?([^\s"'#]+)["']?\s*$/m);
	return m ? m[1].trim() : '';
}

/**
 * @param {string} markdown
 * @returns {string}
 */
function extractTitle(markdown) {
	const m = markdown.match(/^title:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m);
	return (m?.[1] || m?.[2] || m?.[3] || '').trim();
}

/**
 * @param {string} markdown
 * @returns {string}
 */
function extractAutorId(markdown) {
	const m = markdown.match(/^autor:\s*["']?([^\s"'#]+)["']?\s*$/m);
	return m ? m[1].trim() : '';
}

/**
 * Destino do arquivo: slugify(title) quando houver título; senão mantém o nome de origem.
 * @param {string} markdown
 * @param {string} sourceName
 * @returns {string}
 */
function destFileName(markdown, sourceName) {
	const title = extractTitle(markdown);
	if (title) {
		const slug = slugifyTitulo(title);
		if (slug) return `${slug}.md`;
	}
	return sourceName;
}

/**
 * @param {string} markdown
 * @returns {boolean}
 */
function hasEmptyPubDate(markdown) {
	return /^pubDate:\s*(""|)\s*$/m.test(markdown);
}

/**
 * @param {string} markdown
 * @param {Map<string, string>} snapshotByLegacy
 * @returns {{ ok: true, content: string } | { ok: false, reason: string }}
 */
function prepareMarkdown(markdown, snapshotByLegacy) {
	let out = markdown;

	if (!/^draft:\s*true\s*$/m.test(out)) {
		if (/^draft:\s*false\s*$/m.test(out)) {
			out = out.replace(/^draft:\s*false\s*$/m, 'draft: true');
		} else if (out.startsWith('---\n')) {
			out = out.replace('---\n', '---\ndraft: true\n');
		} else {
			out = `---\ndraft: true\n---\n\n${out}`;
		}
	}

	if (hasEmptyPubDate(out)) {
		const legacy = extractLegacyUrl(out);
		const key = normalizeLegacyPath(legacy);
		const snap = key ? snapshotByLegacy.get(key) : '';
		if (!snap || !/^\d{4}-\d{2}-\d{2}/.test(snap)) {
			return {
				ok: false,
				reason: legacy
					? `sem primeiro_snapshot para legacyUrl ${legacy}`
					: 'pubDate vazio e sem legacyUrl',
			};
		}
		const dateOnly = snap.slice(0, 10);
		out = out.replace(/^pubDate:\s*(""|)\s*$/m, `pubDate: ${dateOnly}`);

		if (!out.includes(CONFERIR_PUBDATE)) {
			out = out.replace(
				/^---\n([\s\S]*?)\n---\n/,
				`---\n$1\n---\n\n${CONFERIR_PUBDATE}\n`,
			);
		}
	}

	return { ok: true, content: out };
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listMarkdownFiles(dir) {
	if (!(await exists(dir))) return [];
	const names = await readdir(dir);
	return names.filter((n) => n.endsWith('.md') || n.endsWith('.mdx')).sort();
}

/**
 * @returns {Promise<Map<string, string>>}
 */
async function loadSnapshotByLegacy() {
	/** @type {Map<string, string>} */
	const map = new Map();
	try {
		const text = await readFile(INVENTARIO_CSV, 'utf8');
		for (const row of parseCsv(text)) {
			const path = normalizeLegacyPath(row.url_normalizada || '');
			const snap = (row.primeiro_snapshot || '').trim();
			if (path && snap) map.set(path, snap);
		}
	} catch {
		console.warn(
			`Aviso: não foi possível ler ${INVENTARIO_CSV} — pubDates vazios serão abortados.`,
		);
	}
	return map;
}

async function main() {
	const loteDir = join(RECUPERADOS, 'markdown', `lote-${LOTE}`);
	const srcArtigos = join(loteDir, 'artigos');
	const srcResenhas = join(loteDir, 'resenhas');

	if (!(await exists(loteDir))) {
		console.error(`Lote não encontrado: ${loteDir}`);
		console.error('Rode antes: pnpm wayback:converter --apply');
		process.exitCode = 1;
		return;
	}

	const snapshotByLegacy = await loadSnapshotByLegacy();

	const [artigosFiles, resenhasFiles] = await Promise.all([
		listMarkdownFiles(srcArtigos),
		listMarkdownFiles(srcResenhas),
	]);

	/** @type {{ collection: 'artigos' | 'resenhas', name: string, src: string, dest: string }[]} */
	const candidatos = [];
	for (const name of artigosFiles) {
		const src = join(srcArtigos, name);
		const raw = await readFile(src, 'utf8');
		const destName = destFileName(raw, name);
		candidatos.push({
			collection: 'artigos',
			name: destName,
			src,
			dest: join(DEST_ARTIGOS, destName),
		});
	}
	for (const name of resenhasFiles) {
		const src = join(srcResenhas, name);
		const raw = await readFile(src, 'utf8');
		const destName = destFileName(raw, name);
		candidatos.push({
			collection: 'resenhas',
			name: destName,
			src,
			dest: join(DEST_RESENHAS, destName),
		});
	}

	/** @type {typeof candidatos} */
	const aCopiar = [];
	/** @type {typeof candidatos} */
	const jaPromovidos = [];

	for (const item of candidatos) {
		if (await exists(item.dest)) jaPromovidos.push(item);
		else aCopiar.push(item);
	}

	/** @type {{ item: (typeof candidatos)[0], content: string }[]} */
	const prontos = [];
	/** @type {{ item: (typeof candidatos)[0], reason: string }[]} */
	const abortados = [];

	for (const item of aCopiar) {
		const raw = await readFile(item.src, 'utf8');
		const prepared = prepareMarkdown(raw, snapshotByLegacy);
		if (!prepared.ok) {
			abortados.push({ item, reason: prepared.reason });
			continue;
		}
		prontos.push({ item, content: prepared.content });
	}

	/** @type {Set<string>} */
	const autorIdsCopiados = new Set();
	for (const { content } of prontos) {
		const autorId = extractAutorId(content);
		if (autorId) autorIdsCopiados.add(autorId);
	}

	/** @type {{ id: string, nome: string, bio?: string, avatar?: string }[]} */
	let autoresSite = [];
	try {
		autoresSite = JSON.parse(await readFile(AUTORES_SITE, 'utf8'));
	} catch {
		console.error(`Não foi possível ler ${AUTORES_SITE}`);
		process.exitCode = 1;
		return;
	}

	/** @type {Map<string, { id: string, nome: string, bio?: string }>} */
	const sugeridosById = new Map();
	try {
		const sugeridos = JSON.parse(await readFile(AUTORES_SUGERIDOS, 'utf8'));
		if (Array.isArray(sugeridos)) {
			for (const a of sugeridos) {
				if (a?.id) sugeridosById.set(a.id, a);
			}
		}
	} catch {
		console.warn(
			`Aviso: ${AUTORES_SUGERIDOS} ausente ou inválido — autores novos podem faltar.`,
		);
	}

	const existentes = new Set(autoresSite.map((a) => a.id));
	/** @type {{ id: string, nome: string, bio: string }[]} */
	const autoresNovos = [];
	for (const id of [...autorIdsCopiados].sort((a, b) =>
		a.localeCompare(b, 'pt-BR'),
	)) {
		if (existentes.has(id)) continue;
		const sug = sugeridosById.get(id);
		autoresNovos.push({
			id,
			nome: sug?.nome || id,
			bio: '',
		});
	}

	const porColecao = {
		artigos: {
			copiar: prontos.filter((p) => p.item.collection === 'artigos').length,
			ja: jaPromovidos.filter((i) => i.collection === 'artigos').length,
			abort: abortados.filter((a) => a.item.collection === 'artigos').length,
		},
		resenhas: {
			copiar: prontos.filter((p) => p.item.collection === 'resenhas').length,
			ja: jaPromovidos.filter((i) => i.collection === 'resenhas').length,
			abort: abortados.filter((a) => a.item.collection === 'resenhas').length,
		},
	};

	console.log(`\n=== wayback:promover (lote-${LOTE}) ===`);
	console.log(`Candidatos no lote: ${candidatos.length}`);
	console.log('\nPor coleção:');
	for (const col of ['artigos', 'resenhas']) {
		const c = porColecao[col];
		console.log(
			`  ${col}: copiar=${c.copiar} | já promovido=${c.ja} | abortados=${c.abort}`,
		);
	}
	console.log(`\nTotal a copiar:     ${prontos.length}`);
	console.log(`Já promovidos:      ${jaPromovidos.length}`);
	console.log(`Abortados:          ${abortados.length}`);
	if (abortados.length) {
		for (const a of abortados) {
			console.log(`  ! ${a.item.collection}/${a.item.name} — ${a.reason}`);
		}
	}
	console.log(`Autores novos:      ${autoresNovos.length}`);
	if (autoresNovos.length) {
		for (const a of autoresNovos) {
			console.log(`  + ${a.id} (${a.nome})`);
		}
	}

	if (!APPLY) {
		console.log('\nModo read-only (sem --apply). Nada foi alterado.');
		console.log(
			`Para executar: pnpm wayback:promover --lote=${LOTE} --apply`,
		);
		return;
	}

	await mkdir(DEST_ARTIGOS, { recursive: true });
	await mkdir(DEST_RESENHAS, { recursive: true });

	for (const { item, content } of prontos) {
		await writeFile(item.dest, content, 'utf8');
	}

	if (autoresNovos.length) {
		const atualizados = [
			...autoresSite,
			...autoresNovos.map((a) => ({ id: a.id, nome: a.nome, bio: a.bio })),
		].sort((a, b) => a.id.localeCompare(b.id, 'pt-BR'));
		await writeFile(
			AUTORES_SITE,
			JSON.stringify(atualizados, null, '\t') + '\n',
			'utf8',
		);
	}

	console.log(`\nCopiados ${prontos.length} arquivo(s).`);
	console.log(`Autores.json: +${autoresNovos.length} (existentes preservados).`);
	if (abortados.length) {
		console.log(`Não copiados (abortados): ${abortados.length}`);
	}
	if (jaPromovidos.length) {
		console.log(`Pulados (já promovido): ${jaPromovidos.length}`);
		for (const item of jaPromovidos.slice(0, 20)) {
			console.log(`  - ${item.collection}/${item.name}`);
		}
		if (jaPromovidos.length > 20) {
			console.log(`  … e mais ${jaPromovidos.length - 20}`);
		}
	}
}

main().catch((err) => {
	console.error('Falha em wayback:promover:', err);
	process.exitCode = 1;
});
