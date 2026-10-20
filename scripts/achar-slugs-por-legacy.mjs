#!/usr/bin/env node
/**
 * Read-only. Descobre, para URLs antigas com backlink, o slug do Markdown em
 * _recuperados/markdown/lote-N/{artigos,resenhas}/ (o nome do arquivo vem do título
 * limpo, não da URL antiga) e imprime o comando pnpm wayback:promover pronto.
 * Uso: node scripts/achar-slugs-por-legacy.mjs
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseCsvWithHeaders } from './lib/csv.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, '_recuperados', 'markdown');

/** URLs antigas com backlink (Semrush, out/2026), em ordem de valor. */
const ALVOS = [
	'/oblogquenaoestavala/nos-cinemas-oblivion-2013/',
	'/na-mesa-10-subcelebridades/',
	'/mad-max-estrada-da-furia-critica/',
	'/memorias-da-boca-resenha/',
	'/os-oito-odiados-critica-2/',
	'/ela-critica/',
	'/homem-formiga-critica/',
	'/snoopy-charlie-brown-peanuts-o-filme/',
	'/batman-1989-critica/',
	'/capitao-america-2-o-soldado-invernal-critica/',
	'/o-homem-duplicado-critica/',
	'/o-congresso-futurista-critica/',
	'/viver-e-mais-facil-com-os-olhos-fechados-critica/',
	'/memorias-de-minhas-pautas-tristes-critica/',
];

/** @param {string} p */
function norm(p) {
	let s = p.trim().toLowerCase().replace(/^\/index\.php/, '');
	if (!s.startsWith('/')) s = `/${s}`;
	if (!s.endsWith('/')) s += '/';
	return s;
}
/** Chave frouxa: tira prefixo /oblogquenaoestavala e sufixos -critica/-resenha/-2. */
function frouxa(p) {
	return norm(p)
		.replace(/^\/oblogquenaoestavala/, '')
		.replace(/(-critica|-resenha)(-\d+)?\/$/, '/')
		.replace(/-\d+\/$/, '/');
}

async function listar() {
	const out = [];
	let lotes = [];
	try {
		lotes = (await readdir(BASE)).filter((n) => /^lote-\d+$/.test(n));
	} catch {
		console.error(`Pasta não encontrada: ${BASE}. Rode antes: pnpm wayback:converter --apply`);
		process.exit(1);
	}
	for (const lote of lotes) {
		for (const col of ['artigos', 'resenhas']) {
			let nomes = [];
			try {
				nomes = (await readdir(join(BASE, lote, col))).filter((n) => n.endsWith('.md'));
			} catch {
				continue;
			}
			for (const nome of nomes) {
				const txt = await readFile(join(BASE, lote, col, nome), 'utf8');
				const legacy = txt.match(/^legacyUrl:\s*["']?([^\s"'#]+)["']?\s*$/m)?.[1] ?? '';
				const title = txt.match(/^title:\s*(?:"([^"]*)"|(.+))\s*$/m);
				out.push({
					slug: nome.replace(/\.md$/, ''),
					lote,
					col,
					legacy,
					title: (title?.[1] || title?.[2] || '').trim(),
				});
			}
		}
	}
	return out;
}

const itens = await listar();
const exatos = new Map(itens.filter((i) => i.legacy).map((i) => [norm(i.legacy), i]));
const soltos = new Map(itens.filter((i) => i.legacy).map((i) => [frouxa(i.legacy), i]));

const achados = [];
const faltam = [];
for (const alvo of ALVOS) {
	const i = exatos.get(norm(alvo)) ?? soltos.get(frouxa(alvo));
	if (i) {
		const aprox = exatos.has(norm(alvo)) ? '' : ' (correspondência aproximada, confira)';
		console.log(`OK  ${alvo}\n    -> ${i.slug}  [${i.lote}/${i.col}] "${i.title}"${aprox}`);
		achados.push(i.slug);
	} else {
		console.log(`--  ${alvo}\n    -> não está nos Markdown convertidos (aprovar=nao, podcast ou fora do inventário)`);
		faltam.push(alvo);
	}
}
// Diagnóstico das não encontradas: o que os CSVs do pipeline dizem sobre cada uma.
const COLS = ['url_normalizada', 'tipo_final', 'sugestao', 'motivo', 'aprovar', 'palavras', 'palavras_corpo', 'primeiro_snapshot'];
if (faltam.length) {
	console.log('\n=== Diagnóstico das não encontradas (CSVs em _recuperados) ===');
	for (const arq of ['inventario.csv', 'metadados.csv', 'decisoes-manuais.csv']) {
		let rows = [];
		try {
			rows = parseCsvWithHeaders(await readFile(join(ROOT, '_recuperados', arq), 'utf8')).rows;
		} catch {
			console.log(`(sem ${arq})`);
			continue;
		}
		for (const alvo of faltam) {
			const casados = rows.filter((r) => {
				const u = r.url_normalizada || r.url || '';
				if (!u) return false;
				let path = u;
				try { path = new URL(u).pathname; } catch {}
				return norm(path) === norm(alvo) || frouxa(path) === frouxa(alvo);
			});
			if (!casados.length) {
				console.log(`[${arq}] ${alvo}: sem linha`);
				continue;
			}
			for (const r of casados) {
				const resumo = COLS.filter((c) => r[c] !== undefined && r[c] !== '')
					.map((c) => `${c}=${r[c]}`)
					.join(' | ');
				console.log(`[${arq}] ${alvo}: ${resumo}`);
			}
		}
	}
}
console.log(`\nEncontrados: ${achados.length} | Não encontrados: ${faltam.length}`);
if (achados.length) {
	console.log('\nDry-run (sem gravar):');
	console.log(`pnpm wayback:promover --arquivos=${[...new Set(achados)].join(',')}`);
}
