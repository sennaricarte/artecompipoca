#!/usr/bin/env node
/**
 * Lista ocorrências de "[PREENCHER" em src/ e public/.
 * Na Vercel (VERCEL=1): exit 1 se houver ocorrências.
 * Localmente: aviso amarelo e exit 0.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIRS = [join(ROOT, 'src'), join(ROOT, 'public')];
const NEEDLE = '[PREENCHER';
const ON_VERCEL = process.env.VERCEL === '1';

const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function walkFiles(dir) {
	/** @type {string[]} */
	const files = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files;
	}

	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(full)));
			continue;
		}
		if (entry.isFile()) files.push(full);
	}
	return files;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ file: string, line: number, text: string }[]>}
 */
async function findInFile(filePath) {
	let content;
	try {
		const info = await stat(filePath);
		if (info.size > 2_000_000) return [];
		content = await readFile(filePath, 'utf8');
	} catch {
		return [];
	}

	// Pular binários óbvios
	if (content.includes('\0')) return [];

	const rel = relative(ROOT, filePath).replace(/\\/g, '/');
	/** @type {{ file: string, line: number, text: string }[]} */
	const hits = [];
	const lines = content.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(NEEDLE)) {
			hits.push({ file: rel, line: i + 1, text: lines[i].trim() });
		}
	}
	return hits;
}

async function main() {
	/** @type {{ file: string, line: number, text: string }[]} */
	const hits = [];
	for (const dir of DIRS) {
		const files = await walkFiles(dir);
		for (const file of files) {
			hits.push(...(await findInFile(file)));
		}
	}

	if (hits.length === 0) {
		console.log('checar-preencher: nenhuma ocorrência de [PREENCHER].');
		return;
	}

	const lista = hits
		.map((h) => `  ${h.file}:${h.line}: ${h.text}`)
		.join('\n');

	if (ON_VERCEL) {
		console.error(
			`checar-preencher: ${hits.length} ocorrência(s) de [PREENCHER] — deploy bloqueado.\n${lista}`,
		);
		process.exitCode = 1;
		return;
	}

	console.warn(
		`${YELLOW}AVISO checar-preencher: ${hits.length} ocorrência(s) de [PREENCHER] (ok em local; na Vercel o build falha).\n${lista}${RESET}`,
	);
}

main().catch((err) => {
	console.error('checar-preencher falhou:', err);
	process.exitCode = 1;
});
