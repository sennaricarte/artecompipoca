#!/usr/bin/env node
/**
 * Busca obras de listas (headings h2) no Wikidata e grava CSV para revisão.
 * Uso: pnpm obras:listas <slug> [--tipo=filme|serie] [--ignorar="texto1|texto2"] [--apply]
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvWithHeaders, serializeCsv } from './lib/csv.mjs';
import { splitFrontmatter, yamlScalar } from './lib/frontmatter.mjs';
import {
	confiancaAlta,
	entityMatchesTipo,
	fetchCandidatesData,
	normalize,
	scoreCandidate,
	searchIds,
} from './lib/wikidata.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ARTIGOS = join(ROOT, 'src', 'content', 'artigos');
const RECUPERADOS = join(ROOT, '_recuperados');

const APPLY = process.argv.includes('--apply');
const TIPO_ARG = process.argv.find((a) => a.startsWith('--tipo='));
const IGNORAR_ARG = process.argv.find((a) => a.startsWith('--ignorar='));
const TIPO = TIPO_ARG?.slice('--tipo='.length) === 'serie' ? 'serie' : 'filme';
const IGNORAR_PREFIXOS = String(IGNORAR_ARG?.slice('--ignorar='.length) || '')
	.split('|')
	.map((s) => normalize(s))
	.filter(Boolean);

const CSV_HEADERS = [
	'titulo',
	'titulo_busca',
	'ano_busca',
	'wikidataId',
	'rotulo',
	'ano_item',
	'confianca',
	'pontuacao',
	'url',
	'aprovar',
];

/** @type {Record<string, { titulo_busca: string, ano_busca: number }[]>} */
const BUSCA_POR_SLUG = {
	'top-5-viagem-no-tempo': [
		{ titulo_busca: 'Looper', ano_busca: 2012 },
		{ titulo_busca: 'The Terminator', ano_busca: 1984 },
		{ titulo_busca: '12 Monkeys', ano_busca: 1995 },
		{ titulo_busca: 'Back to the Future', ano_busca: 1985 },
		{ titulo_busca: 'Predestination', ano_busca: 2014 },
	],
	'top-5-filmes-de-ficcao-cientifica': [
		{ titulo_busca: 'The Matrix', ano_busca: 1999 },
		{ titulo_busca: 'Metropolis', ano_busca: 1927 },
		{ titulo_busca: 'Planet of the Apes', ano_busca: 1968 },
		{ titulo_busca: '2001: A Space Odyssey', ano_busca: 1968 },
		{ titulo_busca: 'Blade Runner', ano_busca: 1982 },
	],
};

/**
 * @param {string} heading
 */
function cleanHeadingText(heading) {
	return String(heading || '')
		.replace(/^\*\*(.+)\*\*$/, '$1')
		.trim();
}

/**
 * @param {string} body
 */
function extractH2Headings(body) {
	/** @type {string[]} */
	const out = [];
	for (const line of body.split(/\r?\n/)) {
		const m = line.match(/^##\s+(.+)$/);
		if (!m) continue;
		const titulo = cleanHeadingText(m[1].trim());
		out.push(titulo);
	}
	return out;
}

/**
 * @param {string} titulo
 */
function shouldIgnoreHeading(titulo) {
	const norm = normalize(titulo);
	return IGNORAR_PREFIXOS.some((prefixo) => norm.startsWith(prefixo));
}

/**
 * @param {string} titulo
 * @param {string} [tituloBusca]
 * @param {number | null} [anoBusca]
 */
function ignoredRow(titulo, tituloBusca = '', anoBusca = null) {
	return {
		titulo,
		titulo_busca: tituloBusca,
		ano_busca: anoBusca != null ? String(anoBusca) : '',
		wikidataId: '',
		rotulo: '',
		ano_item: '',
		confianca: '',
		pontuacao: '',
		url: '',
		aprovar: 'ignorar',
	};
}

/**
 * @param {string} heading
 */
function parseHeadingYears(heading) {
	const range = heading.match(
		/^(.+?)\s*\((\d{4})(?:\s*[–—-]\s*(?:\d{4}|Atualmente))?\)\s*$/i,
	);
	if (range) {
		return {
			titulo: heading,
			titulo_busca: range[1].trim(),
			ano_busca: Number(range[2]),
		};
	}
	return {
		titulo: heading,
		titulo_busca: heading,
		ano_busca: null,
	};
}

/**
 * @param {string} slug
 * @param {string[]} headings
 */
function resolveBusca(slug, headings) {
	const override = BUSCA_POR_SLUG[slug];
	if (override) {
		const items = override.slice(0, headings.length);
		return headings.map((titulo, i) => ({
			titulo,
			titulo_busca: items[i]?.titulo_busca ?? parseHeadingYears(titulo).titulo_busca,
			ano_busca: items[i]?.ano_busca ?? parseHeadingYears(titulo).ano_busca,
		}));
	}
	return headings.map((titulo) => parseHeadingYears(titulo));
}

/**
 * @param {string} titulo
 * @param {string} tituloBusca
 * @param {number | null} anoBusca
 * @param {'filme' | 'serie'} tipo
 */
async function buscarObra(titulo, tituloBusca, anoBusca, tipo) {
	console.log(`→ "${titulo}" (busca: "${tituloBusca}"${anoBusca ? `, ${anoBusca}` : ''})`);

	/** @type {string[]} */
	let ids = [];
	try {
		ids = await searchIds(tituloBusca, tipo);
	} catch (err) {
		console.warn(`  busca falhou: ${err.message || err}`);
	}

	let candidates = [];
	try {
		candidates = await fetchCandidatesData(ids, tipo);
	} catch (err) {
		console.warn(`  fetch falhou: ${err.message || err}`);
	}

	const ctx = {
		obra: tituloBusca,
		title: titulo,
		anoObra: Number.isFinite(anoBusca) ? anoBusca : null,
		pubYear: null,
	};

	const scored = candidates
		.map((c) => {
			const { score, titulosCasados, tituloExato } = scoreCandidate(c, ctx);
			return { ...c, pontuacao: score, titulosCasados, tituloExato };
		})
		.sort(
			(a, b) =>
				b.pontuacao - a.pontuacao ||
				(b.sitelinks || 0) - (a.sitelinks || 0) ||
				ids.indexOf(a.id) - ids.indexOf(b.id),
		);

	if (!scored.length) {
		console.log('  sem candidato');
		return {
			titulo,
			titulo_busca: tituloBusca,
			ano_busca: anoBusca != null ? String(anoBusca) : '',
			wikidataId: '',
			rotulo: '',
			ano_item: '',
			confianca: 'baixa',
			pontuacao: '0',
			url: '',
			aprovar: '',
		};
	}

	const best = scored[0];
	const second = scored[1];
	const confianca = confiancaAlta(best, second, scored) ? 'alta' : 'baixa';
	const anoItem = tipo === 'serie' ? (best.anoInicio ?? best.ano) : best.ano;

	console.log(
		`  ${best.id} “${best.rotulo}” pts=${best.pontuacao} conf=${confianca}`,
	);

	return {
		titulo,
		titulo_busca: tituloBusca,
		ano_busca: anoBusca != null ? String(anoBusca) : '',
		wikidataId: best.id,
		rotulo: best.rotulo,
		ano_item: anoItem != null ? String(anoItem) : '',
		confianca,
		pontuacao: String(best.pontuacao),
		url: `https://www.wikidata.org/wiki/${best.id}`,
		aprovar: confianca === 'alta' ? 'sim' : '',
	};
}

/**
 * @param {any} cand
 * @param {string} tituloHeading
 * @param {'filme' | 'serie'} tipo
 */
function extractObraFields(cand, tituloHeading, tipo) {
	/** @type {Record<string, unknown>} */
	const obra = {
		titulo: tituloHeading,
		tipo,
		wikidataId: cand.id,
	};
	if (cand.tituloOriginal) obra.tituloOriginal = cand.tituloOriginal;
	const ano = tipo === 'serie' ? (cand.anoInicio ?? cand.ano) : cand.ano;
	if (ano != null) obra.ano = ano;
	if (tipo === 'filme' && cand.direcao?.length) obra.direcao = cand.direcao;
	if (tipo === 'serie') {
		if (cand.anoFim != null) obra.anoFim = cand.anoFim;
		if (cand.temporadas != null) obra.temporadas = cand.temporadas;
		const criacao = cand.criadores?.length
			? cand.criadores
			: cand.roteiro?.length
				? cand.roteiro
				: [];
		if (criacao.length) obra.criacao = criacao;
	}
	return obra;
}

/**
 * @param {Record<string, unknown>[]} obras
 */
function obrasToYaml(obras) {
	/** @type {string[]} */
	const lines = ['obras:'];
	for (const obra of obras) {
		lines.push(`  - titulo: ${yamlScalar(String(obra.titulo))}`);
		lines.push(`    tipo: ${obra.tipo}`);
		lines.push(`    wikidataId: ${obra.wikidataId}`);
		if (obra.tituloOriginal) {
			lines.push(`    tituloOriginal: ${yamlScalar(String(obra.tituloOriginal))}`);
		}
		if (obra.ano != null) lines.push(`    ano: ${obra.ano}`);
		if (obra.anoFim != null) lines.push(`    anoFim: ${obra.anoFim}`);
		if (Array.isArray(obra.direcao) && obra.direcao.length) {
			lines.push('    direcao:');
			for (const n of obra.direcao) lines.push(`      - ${yamlScalar(String(n))}`);
		}
		if (Array.isArray(obra.criacao) && obra.criacao.length) {
			lines.push('    criacao:');
			for (const n of obra.criacao) lines.push(`      - ${yamlScalar(String(n))}`);
		}
		if (obra.temporadas != null) lines.push(`    temporadas: ${obra.temporadas}`);
	}
	return lines.join('\n');
}

/**
 * @param {string} fm
 * @param {Record<string, unknown>[]} obras
 */
function setObrasInFrontmatter(fm, obras) {
	const lines = fm.replace(/\r\n/g, '\n').split('\n');
	const start = lines.findIndex((l) => /^obras:\s*$/.test(l));
	const yaml = obrasToYaml(obras).split('\n').slice(1);
	if (start === -1) {
		return `${fm.replace(/\s+$/, '')}\n${obrasToYaml(obras)}`;
	}
	let end = start + 1;
	while (end < lines.length && (/^  /.test(lines[end]) || lines[end] === '')) {
		end += 1;
	}
	return [...lines.slice(0, start), ...obrasToYaml(obras).split('\n'), ...lines.slice(end)]
		.join('\n')
		.replace(/\s+$/, '');
}

/**
 * @param {string} slug
 */
async function runSearch(slug) {
	const filePath = join(ARTIGOS, `${slug}.md`);
	const raw = await readFile(filePath, 'utf8');
	const parts = splitFrontmatter(raw);
	if (!parts) throw new Error(`Sem frontmatter: ${filePath}`);

	const headings = extractH2Headings(parts.body);
	const buscas = resolveBusca(slug, headings);
	const outCsv = join(RECUPERADOS, `obras-${slug}.csv`);

	/** @type {Map<string, Record<string, string>>} */
	const existentes = new Map();
	try {
		const prev = await readFile(outCsv, 'utf8');
		for (const row of parseCsvWithHeaders(prev).rows) {
			if (row.titulo) existentes.set(row.titulo, row);
		}
	} catch {
		// CSV novo
	}

	/** @type {Record<string, string>[]} */
	const rows = [];
	for (const item of buscas) {
		if (shouldIgnoreHeading(item.titulo)) {
			rows.push(ignoredRow(item.titulo, item.titulo_busca, item.ano_busca));
			console.log(`- ignorado: "${item.titulo}"`);
			continue;
		}
		if (existentes.has(item.titulo)) {
			const prev = existentes.get(item.titulo);
			if (String(prev.aprovar || '').trim().toLowerCase() === 'ignorar') {
				rows.push(prev);
				console.log(`= ignorado (CSV): "${item.titulo}"`);
				continue;
			}
			if (String(prev.wikidataId || '').trim()) {
				rows.push(prev);
				console.log(`= preservado: "${item.titulo}"`);
				continue;
			}
			const tituloBusca =
				String(prev.titulo_busca || '').trim() || item.titulo_busca;
			const anoRaw = prev.ano_busca || item.ano_busca;
			const anoBusca = anoRaw ? Number(anoRaw) : item.ano_busca;
			rows.push(
				await buscarObra(item.titulo, tituloBusca, anoBusca, TIPO),
			);
			continue;
		}
		rows.push(
			await buscarObra(item.titulo, item.titulo_busca, item.ano_busca, TIPO),
		);
	}

	await mkdir(RECUPERADOS, { recursive: true });
	await writeFile(outCsv, serializeCsv(CSV_HEADERS, rows), 'utf8');
	console.log(`\nCSV: ${outCsv}`);
}

/**
 * @param {string} slug
 */
async function runApply(slug) {
	const filePath = join(ARTIGOS, `${slug}.md`);
	const outCsv = join(RECUPERADOS, `obras-${slug}.csv`);
	const raw = await readFile(filePath, 'utf8');
	const parts = splitFrontmatter(raw);
	if (!parts) throw new Error(`Sem frontmatter: ${filePath}`);

	const { rows } = parseCsvWithHeaders(await readFile(outCsv, 'utf8'));
	const aprovadas = rows.filter(
		(r) => String(r.aprovar || '').trim().toLowerCase() === 'sim',
	);

	/** @type {Record<string, unknown>[]} */
	const obras = [];
	for (const row of aprovadas) {
		const wikidataId = String(row.wikidataId || '').trim();
		if (!/^Q\d+$/.test(wikidataId)) {
			console.warn(`  skip (sem wikidataId): ${row.titulo}`);
			continue;
		}

		const ok = await entityMatchesTipo(wikidataId, TIPO);
		if (!ok) {
			console.warn(`  classe inválida: ${row.titulo} → ${wikidataId}`);
			continue;
		}

		const candidates = await fetchCandidatesData([wikidataId], TIPO);
		const cand = candidates[0];
		if (!cand) {
			console.warn(`  sem dados: ${row.titulo}`);
			continue;
		}

		obras.push(extractObraFields(cand, row.titulo, TIPO));
		console.log(`  ok ${row.titulo} → ${wikidataId}`);
	}

	const fm = setObrasInFrontmatter(parts.fm, obras);
	const next = `${parts.open}${fm}${parts.close}${parts.body}`;
	await writeFile(filePath, next, 'utf8');
	console.log(`\n--apply: ${obras.length} obras gravadas em ${slug}.md`);
}

async function main() {
	const slug = process.argv.slice(2).find((a) => !a.startsWith('--'));
	if (!slug) {
		console.error(
			'Uso: pnpm obras:listas <slug-do-artigo> [--tipo=filme|serie] [--ignorar="texto1|texto2"] [--apply]',
		);
		process.exit(1);
	}
	if (TIPO !== 'filme' && TIPO !== 'serie') {
		console.error('--tipo deve ser filme ou serie');
		process.exit(1);
	}

	if (APPLY) await runApply(slug);
	else await runSearch(slug);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
