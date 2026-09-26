#!/usr/bin/env node
/**
 * Remove restos de plugins WordPress do Markdown do acervo.
 * Read-only por padrão. Com --apply: grava as alterações.
 * Uso: pnpm limpar:artefatos [--apply]
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const DIRS = [
	join(ROOT, 'src', 'content'),
	join(ROOT, '_recuperados', 'markdown'),
];

const SHARE_LINES = new Set([
	'Compartilhe',
	'Share this:',
	'Curtir isso:',
	'Relacionado',
]);

/**
 * @param {string} dir
 * @param {string[]} out
 */
async function walkMd(dir, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
			return out;
		}
		throw err;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) await walkMd(p, out);
		else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
	}
	return out;
}

/**
 * @param {string} raw
 * @returns {{ front: string, body: string, hasFm: boolean }}
 */
function splitFrontmatter(raw) {
	if (!raw.startsWith('---')) {
		return { front: '', body: raw, hasFm: false };
	}
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { front: '', body: raw, hasFm: false };
	return {
		front: match[0].replace(/\r?\n$/, ''),
		body: raw.slice(match[0].length),
		hasFm: true,
	};
}

/**
 * @param {string} line
 * @returns {{ level: number, text: string } | null}
 */
function parseHeading(line) {
	const m = line.match(/^(#{1,6})\s+(.*)$/);
	if (!m) return null;
	return { level: m[1].length, text: m[2].trim() };
}

/**
 * @param {string} s
 * @param {number} [max]
 */
function preview(s, max = 160) {
	const one = s.replace(/\s+/g, ' ').trim();
	if (one.length <= max) return one;
	return `${one.slice(0, max - 1)}…`;
}

/**
 * @typedef {{ tipo: string, trecho: string }} Remocao
 */

/**
 * @param {string} body
 * @returns {{ body: string, remocoes: Remocao[] }}
 */
function limparBody(body) {
	/** @type {Remocao[]} */
	const remocoes = [];
	let text = body;

	// 1) Caixa de autor: linha do marcador até o fim do arquivo
	{
		const re =
			/(^|\r?\n)The following two tabs change content below\.\s*(?:\r?\n|$)[\s\S]*$/;
		const m = text.match(re);
		if (m) {
			const removed = m[0].replace(/^\r?\n/, '');
			remocoes.push({ tipo: 'caixa-autor', trecho: preview(removed) });
			text = text.slice(0, m.index).replace(/\s+$/, '');
			if (text) text += '\n';
		}
	}

	// 2) "Você também vai gostar de ler" até próximo heading do mesmo nível ou EOF
	{
		const lines = text.split(/\r?\n/);
		/** @type {string[]} */
		const out = [];
		let i = 0;
		while (i < lines.length) {
			const h = parseHeading(lines[i]);
			if (h && /você também vai gostar de ler/i.test(h.text)) {
				/** @type {string[]} */
				const block = [lines[i]];
				i += 1;
				while (i < lines.length) {
					const next = parseHeading(lines[i]);
					if (next && next.level === h.level) break;
					block.push(lines[i]);
					i += 1;
				}
				remocoes.push({
					tipo: 'leia-tambem',
					trecho: preview(block.join('\n')),
				});
				continue;
			}
			out.push(lines[i]);
			i += 1;
		}
		text = out.join('\n');
	}

	// 3) Links com texto vazio [](url)
	{
		const re = /\[]\([^)]+\)/g;
		const found = text.match(re) || [];
		for (const f of found) {
			remocoes.push({ tipo: 'link-vazio', trecho: f });
		}
		if (found.length) text = text.replace(re, '');
	}

	// 4) Linhas só de compartilhamento / relacionado
	{
		const lines = text.split(/\r?\n/);
		/** @type {string[]} */
		const out = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (SHARE_LINES.has(trimmed)) {
				remocoes.push({ tipo: 'linha-share', trecho: trimmed });
				continue;
			}
			out.push(line);
		}
		text = out.join('\n');
	}

	// 5) Limpar linhas que ficaram só com espaços e colapsar vazios
	text = text
		.split(/\r?\n/)
		.map((l) => (l.trim() === '' ? '' : l))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/^\n+/, '')
		.replace(/\n+$/, '\n');

	return { body: text, remocoes };
}

async function main() {
	/** @type {Map<string, number>} */
	const totais = new Map();
	let arquivosAlterados = 0;

	/** @type {string[]} */
	const files = [];
	for (const d of DIRS) {
		await walkMd(d, files);
	}
	files.sort();

	for (const file of files) {
		const raw = await readFile(file, 'utf8');
		const { front, body, hasFm } = splitFrontmatter(raw);
		const { body: limpo, remocoes } = limparBody(body);
		if (remocoes.length === 0) continue;

		const next = hasFm ? `${front}\n${limpo}` : limpo;
		if (next === raw) continue;

		arquivosAlterados += 1;
		const rel = relative(ROOT, file).replace(/\\/g, '/');

		if (!APPLY) {
			console.log(`\n## ${rel}`);
			for (const r of remocoes) {
				console.log(`- [${r.tipo}] ${r.trecho}`);
			}
		}

		for (const r of remocoes) {
			totais.set(r.tipo, (totais.get(r.tipo) || 0) + 1);
		}

		if (APPLY) {
			await writeFile(file, next, 'utf8');
		}
	}

	console.log('');
	if (!APPLY) {
		console.log(
			`Modo dry-run: ${arquivosAlterados} arquivo(s) com artefatos. Rode com --apply para gravar.`,
		);
	} else {
		console.log(`Aplicado em ${arquivosAlterados} arquivo(s). Totais por tipo:`);
	}
	for (const [tipo, n] of [...totais.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		console.log(`  ${tipo}: ${n}`);
	}
	if (totais.size === 0) console.log('  (nenhum artefato encontrado)');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
