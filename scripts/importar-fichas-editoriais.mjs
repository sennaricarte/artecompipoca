#!/usr/bin/env node
/**
 * Importa campos editoriais (sinopse, curiosidades, prêmios, fontes, trailer)
 * para o bloco ficha do frontmatter das resenhas.
 * Read-only por padrão. Com --apply grava.
 *
 * Uso:
 *   pnpm fichas:importar _recuperados/fichas-editoriais-piloto.json
 *   pnpm fichas:importar _recuperados/fichas-editoriais-piloto.json --apply
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESENHAS = join(ROOT, 'src', 'content', 'resenhas');

const APPLY = process.argv.includes('--apply');
const JSON_ARG = process.argv.slice(2).find((a) => !a.startsWith('-'));

const EDITORIAL_KEYS = new Set([
	'sinopse',
	'curiosidades',
	'premios',
	'trailerYoutubeId',
	'fontes',
]);

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
 * Remove chaves editoriais do bloco ficha (linhas indentadas sob ficha:).
 * @param {string[]} fichaLines linhas já sem o prefixo "ficha:"
 */
function stripEditorialLines(fichaLines) {
	/** @type {string[]} */
	const out = [];
	let skipping = false;
	for (const line of fichaLines) {
		if (/^  [A-Za-z_]/.test(line)) {
			const key = line.match(/^  ([A-Za-z_][\w]*)\s*:/)?.[1];
			skipping = Boolean(key && EDITORIAL_KEYS.has(key));
		}
		if (!skipping) out.push(line);
	}
	return out;
}

/**
 * @param {Record<string, unknown>} editorial
 */
function editorialToYamlLines(editorial) {
	/** @type {string[]} */
	const lines = [];

	if (typeof editorial.sinopse === 'string' && editorial.sinopse.trim()) {
		lines.push(`  sinopse: ${yamlScalar(editorial.sinopse.trim())}`);
	}

	if (Array.isArray(editorial.curiosidades) && editorial.curiosidades.length) {
		lines.push('  curiosidades:');
		for (const item of editorial.curiosidades) {
			lines.push(`    - ${yamlScalar(String(item))}`);
		}
	}

	if (Array.isArray(editorial.premios) && editorial.premios.length) {
		lines.push('  premios:');
		for (const item of editorial.premios) {
			lines.push(`    - ${yamlScalar(String(item))}`);
		}
	}

	if (
		typeof editorial.trailerYoutubeId === 'string' &&
		editorial.trailerYoutubeId.trim()
	) {
		lines.push(
			`  trailerYoutubeId: ${yamlScalar(editorial.trailerYoutubeId.trim())}`,
		);
	}

	if (Array.isArray(editorial.fontes) && editorial.fontes.length) {
		lines.push('  fontes:');
		for (const fonte of editorial.fontes) {
			if (!fonte || typeof fonte !== 'object') continue;
			const nome = /** @type {{ nome?: string, url?: string }} */ (fonte).nome;
			const url = /** @type {{ nome?: string, url?: string }} */ (fonte).url;
			if (!nome || !url) continue;
			lines.push(`    - nome: ${yamlScalar(String(nome))}`);
			lines.push(`      url: ${yamlScalar(String(url))}`);
		}
	}

	return lines;
}

/**
 * @param {string} fm
 * @param {Record<string, unknown>} editorial
 */
function mergeFichaEditorial(fm, editorial) {
	const lines = fm.replace(/\r\n/g, '\n').split('\n');
	const fichaIdx = lines.findIndex((l) => /^ficha:\s*$/.test(l));

	if (fichaIdx === -1) {
		const editorialLines = editorialToYamlLines(editorial);
		if (!editorialLines.length) return fm;
		return `${fm.replace(/\s+$/, '')}\nficha:\n${editorialLines.join('\n')}`;
	}

	let end = fichaIdx + 1;
	while (end < lines.length && (/^  /.test(lines[end]) || lines[end] === '')) {
		end += 1;
	}

	const existing = lines.slice(fichaIdx + 1, end);
	const kept = stripEditorialLines(existing).filter((l, i, arr) => {
		if (l !== '') return true;
		return i > 0 && i < arr.length - 1;
	});
	const added = editorialToYamlLines(editorial);
	const newBlock = ['ficha:', ...kept, ...added].filter((l, i, arr) => {
		if (l !== '') return true;
		return i > 0 && arr[i - 1] !== '';
	});

	return [...lines.slice(0, fichaIdx), ...newBlock, ...lines.slice(end)].join(
		'\n',
	);
}

/**
 * @param {string} body
 * @param {string} texto
 */
function upsertConferir(body, texto) {
	const comment = `<!-- CONFERIR: ${texto} -->\n`;
	const cleaned = body.replace(/^<!-- CONFERIR:[\s\S]*?-->\r?\n/, '');
	if (cleaned.startsWith('\n') || cleaned === '') {
		return comment + cleaned;
	}
	return comment + '\n' + cleaned;
}

async function main() {
	if (!JSON_ARG) {
		console.error(
			'Uso: pnpm fichas:importar <caminho.json> [--apply]\n' +
				'Ex.: pnpm fichas:importar _recuperados/fichas-editoriais-piloto.json --apply',
		);
		process.exit(1);
	}

	const jsonPath = isAbsolute(JSON_ARG)
		? JSON_ARG
		: resolve(ROOT, JSON_ARG);

	const raw = await readFile(jsonPath, 'utf8');
	const itens = JSON.parse(raw);
	if (!Array.isArray(itens)) {
		throw new Error('JSON deve ser um array de itens');
	}

	console.log(
		APPLY
			? `Aplicando fichas editoriais (${itens.length} itens)…`
			: `Dry-run (${itens.length} itens). Use --apply para gravar.`,
	);

	let ok = 0;
	let fail = 0;

	for (const item of itens) {
		const arquivo = item?.arquivo;
		if (!arquivo || typeof arquivo !== 'string') {
			console.warn('  item sem arquivo — ignorado');
			fail += 1;
			continue;
		}

		const path = join(RESENHAS, arquivo);
		let fileRaw;
		try {
			fileRaw = await readFile(path, 'utf8');
		} catch {
			console.warn(`  ${arquivo}: arquivo não encontrado`);
			fail += 1;
			continue;
		}

		const parts = splitFrontmatter(fileRaw);
		if (!parts) {
			console.warn(`  ${arquivo}: sem frontmatter`);
			fail += 1;
			continue;
		}

		const editorial = {
			sinopse: item.sinopse,
			curiosidades: item.curiosidades,
			premios: item.premios,
			trailerYoutubeId: item.trailerYoutubeId,
			fontes: item.fontes,
		};

		const newFm = mergeFichaEditorial(parts.fm, editorial);
		let newBody = parts.body;
		if (typeof item.conferir === 'string' && item.conferir.trim()) {
			newBody = upsertConferir(newBody, item.conferir.trim());
		}

		const next = parts.open + newFm + parts.close + newBody;
		const mudou = next !== fileRaw;

		const campos = [
			editorial.sinopse && 'sinopse',
			Array.isArray(editorial.curiosidades) &&
				editorial.curiosidades.length &&
				`curiosidades(${editorial.curiosidades.length})`,
			Array.isArray(editorial.premios) &&
				editorial.premios.length &&
				`premios(${editorial.premios.length})`,
			editorial.trailerYoutubeId && 'trailer',
			Array.isArray(editorial.fontes) &&
				editorial.fontes.length &&
				`fontes(${editorial.fontes.length})`,
			item.conferir && 'conferir',
		].filter(Boolean);

		console.log(
			`  ${arquivo}: ${campos.join(', ') || '(vazio)'}${mudou ? '' : ' (sem mudança)'}`,
		);

		if (APPLY && mudou) {
			await writeFile(path, next, 'utf8');
		}
		ok += 1;
	}

	console.log(`\nConcluído: ${ok} ok, ${fail} falhas.${APPLY ? ' Gravado.' : ''}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
