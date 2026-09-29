#!/usr/bin/env node
/**
 * Busca candidatos no Wikidata para fichas de resenhas (filme/série).
 * Read-only por padrão (nas resenhas): a varredura preserva as linhas do CSV e só
 * acrescenta resenhas que ainda não estão nele.
 * Com --apply: rebusca dados pelo wikidataId do CSV e mescla na ficha: só acrescenta
 * campos factuais ausentes (nunca sobrescreve nem toca nos editoriais) e preenche
 * anoObra se estiver vazio.
 * Com --segunda-busca: reprocessa linhas do CSV com titulo_busca e aprovar vazio.
 * Uso: pnpm fichas:wikidata [--apply] [--limite=N] | [--segunda-busca]
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvWithHeaders, parseCsv, serializeCsv } from './lib/csv.mjs';
import {
	csvEscape,
	getScalar,
	splitFrontmatter,
	yamlScalar,
} from './lib/frontmatter.mjs';
import {
	CLASSE_SERIE,
	anoParaSegundaBusca,
	confiancaAlta,
	entityMatchesTipo,
	fetchCandidatesData,
	normalize,
	scoreCandidate,
	searchByTipo,
	searchIds,
} from './lib/wikidata.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RESENHAS = join(ROOT, 'src', 'content', 'resenhas');
const OUT_CSV = join(ROOT, '_recuperados', 'fichas-candidatas.csv');
const APPLY = process.argv.includes('--apply');
const SEGUNDA_BUSCA = process.argv.includes('--segunda-busca');
const LIMITE_ARG = process.argv.find((a) => a.startsWith('--limite='));
const LIMITE = LIMITE_ARG ? Number(LIMITE_ARG.slice('--limite='.length)) : null;

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
function capitalizeFirst(s) {
	if (!s) return s;
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Traduções de gêneros só em inglês → português */
const GENRE_EN_MAP = {
	'romantic comedy': 'Comédia romântica',
	drama: 'Drama',
	comedy: 'Comédia',
	'soap opera': 'Drama',
	'youth series': 'Série adolescente',
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
	add('anoFim', ficha.anoFim);
	add('episodios', ficha.episodios);
	add('situacao', ficha.situacao);
	add('wikidataId', ficha.wikidataId);
	return lines.join('\n');
}

/**
 * @param {unknown} v
 */

/** Campos factuais, na ordem de gravação. Os demais (sinopse, curiosidades,
 * premios, fontes, trailerYoutubeId) são editoriais e nunca são tocados. */
const CHAVES_FACTUAIS = [
	'tituloOriginal',
	'ano',
	'direcao',
	'roteiro',
	'elenco',
	'generos',
	'duracaoMin',
	'paises',
	'criadores',
	'temporadas',
	'emissora',
	'anoFim',
	'episodios',
	'situacao',
	'wikidataId',
];

/** Campos que o Wikidata costuma ter para cada tipo; decide se vale consultar. */
const FACTUAIS_POR_TIPO = {
	filme: ['tituloOriginal', 'ano', 'direcao', 'roteiro', 'elenco', 'generos', 'duracaoMin', 'paises', 'wikidataId'],
	serie: ['tituloOriginal', 'ano', 'criadores', 'elenco', 'generos', 'temporadas', 'emissora', 'paises', 'anoFim', 'episodios', 'situacao', 'wikidataId'],
};

/**
 * @param {string} fm
 */
function localizarFicha(fm) {
	const lines = fm.replace(/\r\n/g, '\n').split('\n');
	const inicio = lines.findIndex((l) => /^ficha:\s*$/.test(l));
	if (inicio === -1) return { lines, inicio: -1, fim: -1 };
	let fim = inicio + 1;
	while (fim < lines.length && (/^  /.test(lines[fim]) || lines[fim] === '')) {
		fim += 1;
	}
	return { lines, inicio, fim };
}

/**
 * Chaves da ficha com valor preenchido (escalar não vazio ou lista/objeto com itens).
 * @param {string} fm
 * @returns {{ existe: boolean, preenchidas: Set<string>, wikidataId: string }}
 */
function lerFicha(fm) {
	const { lines, inicio, fim } = localizarFicha(fm);
	/** @type {Set<string>} */
	const preenchidas = new Set();
	let wikidataId = '';
	if (inicio === -1) return { existe: false, preenchidas, wikidataId };
	const bloco = lines.slice(inicio + 1, fim);
	for (let i = 0; i < bloco.length; i++) {
		const m = bloco[i].match(/^  ([A-Za-z_]\w*)\s*:\s*(.*)$/);
		if (!m) continue;
		const valor = m[2].trim();
		const vazio = valor === '' || valor === '""' || valor === "''" || valor === '[]';
		const temFilhos = /^    \S/.test(bloco[i + 1] || '');
		if (!vazio || temFilhos) preenchidas.add(m[1]);
		if (m[1] === 'wikidataId' && !vazio) wikidataId = valor.replace(/^["']|["']$/g, '');
	}
	return { existe: true, preenchidas, wikidataId };
}

/**
 * Acrescenta à ficha só os campos factuais ausentes. Linhas de campos factuais
 * vazios são substituídas; nada preenchido é alterado.
 * @param {string} fm
 * @param {any} novos campos já filtrados (só os ausentes)
 */
function acrescentarNaFicha(fm, novos) {
	const { lines, inicio, fim } = localizarFicha(fm);
	const yaml = fichaToYaml(novos).split('\n').slice(1);
	if (inicio === -1) {
		return `${fm.replace(/\s+$/, '')}\nficha:\n${yaml.join('\n')}`;
	}
	/** @type {string[]} */
	const mantidas = [];
	let pularVazia = false;
	for (const line of lines.slice(inicio + 1, fim)) {
		const m = line.match(/^  ([A-Za-z_]\w*)\s*:/);
		if (m) pularVazia = Object.prototype.hasOwnProperty.call(novos, m[1]);
		if (!pularVazia) mantidas.push(line);
	}
	const idxEditorial = mantidas.findIndex((l) => {
		const k = l.match(/^  ([A-Za-z_]\w*)\s*:/)?.[1];
		return k && !CHAVES_FACTUAIS.includes(k);
	});
	const pos = idxEditorial === -1 ? mantidas.length : idxEditorial;
	const bloco = [...mantidas.slice(0, pos), ...yaml, ...mantidas.slice(pos)];
	return [...lines.slice(0, inicio + 1), ...bloco, ...lines.slice(fim)]
		.join('\n')
		.replace(/\s+$/, '');
}

/**
 * @param {string} filePath
 * @param {any} ficha dados do Wikidata
 * @returns {Promise<string[]>} campos acrescentados
 */
async function applyFicha(filePath, ficha) {
	const raw = await readFile(filePath, 'utf8');
	const parts = splitFrontmatter(raw);
	if (!parts) throw new Error(`Sem frontmatter: ${filePath}`);
	const { preenchidas } = lerFicha(parts.fm);

	/** @type {Record<string, unknown>} */
	const novos = {};
	for (const k of CHAVES_FACTUAIS) {
		if (preenchidas.has(k)) continue;
		const v = ficha[k];
		if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
		novos[k] = v;
	}
	/** @type {string[]} */
	const acrescentados = Object.keys(novos);

	let fm = acrescentados.length ? acrescentarNaFicha(parts.fm, novos) : parts.fm;

	if (!/^anoObra:[ \t]*[^\s"']/m.test(fm) && ficha.ano != null) {
		fm = /^anoObra:/m.test(fm)
			? fm.replace(/^anoObra:.*$/m, `anoObra: ${ficha.ano}`)
			: `${fm.replace(/\s+$/, '')}\nanoObra: ${ficha.ano}`;
		acrescentados.push('anoObra');
	}

	if (!acrescentados.length) return [];
	const next = `${parts.open}${fm}${parts.close}${parts.body}`;
	await writeFile(filePath, next, 'utf8');
	return acrescentados;
}

/**
 * Parse CSV simples com aspas.
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */

/**
 * @param {string} text
 */

/**
 * @param {string[]} headers
 * @param {Record<string, string>[]} rows
 */

/**
 * Busca por termo e classes do tipo (sem simplificar o título).
 * @param {string} term
 * @param {'filme' | 'serie'} tipo
 */

/**
 * Ano do item para segunda busca: P577 (filme); P580 ou P577 (série).
 * @param {any} cand
 * @param {'filme' | 'serie'} tipo
 */

/**
 * @param {string} line
 */

async function runApply() {
	const text = await readFile(OUT_CSV, 'utf8');
	const rows = parseCsv(text);
	let applied = 0;
	let skipped = 0;
	let aprovadasVistas = 0;
	let completas = 0;
	/** @type {string[]} */
	const classeInvalida = [];
	/** @type {string[]} */
	const divergentes = [];
	/** @type {string[]} */
	const semNovidade = [];
	/** @type {{ arquivo: string, campos: string[] }[]} */
	const resumo = [];

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
		const tipoFm = getScalar(parts.fm, 'tipo');
		const tipo =
			tipoFm === 'filme' || tipoFm === 'serie'
				? tipoFm
				: row.tipo === 'serie'
					? 'serie'
					: 'filme';

		const atual = lerFicha(parts.fm);
		if (atual.wikidataId && atual.wikidataId !== wikidataId) {
			console.warn(
				`  skip (wikidataId divergente: ficha ${atual.wikidataId}, CSV ${wikidataId}): ${arquivo}`,
			);
			divergentes.push(`${arquivo} (ficha ${atual.wikidataId}, CSV ${wikidataId})`);
			skipped++;
			continue;
		}
		const faltando = FACTUAIS_POR_TIPO[tipo].filter((k) => !atual.preenchidas.has(k));
		const semAnoObra = !/^anoObra:[ \t]*[^\s"']/m.test(parts.fm);
		if (!faltando.length && !semAnoObra) {
			completas++;
			skipped++;
			continue;
		}

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

		const acrescentados = await applyFicha(abs, ficha);
		if (acrescentados.length) {
			applied++;
			resumo.push({ arquivo, campos: acrescentados });
			console.log(`  ok ${arquivo} → ${wikidataId}: +${acrescentados.join(', ')}`);
		} else {
			semNovidade.push(arquivo);
			skipped++;
		}
	}

	console.log(`\n--apply: ${applied} fichas alteradas, ${skipped} ignoradas.`);
	console.log(`  completas (sem consulta): ${completas}`);
	if (semNovidade.length) {
		console.log(`  consultadas sem campo novo (${semNovidade.length}): ${semNovidade.join(', ')}`);
	}
	if (resumo.length) {
		console.log('Campos acrescentados:');
		for (const r of resumo) console.log(`  - ${r.arquivo}: ${r.campos.join(', ')}`);
	}
	if (divergentes.length) {
		console.log(`wikidataId divergente (${divergentes.length}):`);
		for (const line of divergentes) console.log(`  - ${line}`);
	}
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

	/** @type {string[] | null} */
	let headersExistentes = null;
	/** @type {Set<string>} */
	const jaNoCsv = new Set();
	/** @type {string} */
	let textoExistente = '';
	try {
		textoExistente = await readFile(OUT_CSV, 'utf8');
	} catch {
		textoExistente = '';
	}
	if (textoExistente.trim()) {
		const { headers, rows: existentes } = parseCsvWithHeaders(textoExistente);
		headersExistentes = headers;
		for (const r of existentes) {
			if (r.arquivo) jaNoCsv.add(String(r.arquivo).trim());
		}
	}
	let preservadas = 0;

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

		if (jaNoCsv.has(rel)) {
			preservadas++;
			continue;
		}

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
			anoFim: best.anoFim ?? '',
			episodios: best.episodios ?? '',
			situacao: best.situacao || '',
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
		'anoFim',
		'episodios',
		'situacao',
		'emissora',
	];

	await mkdir(dirname(OUT_CSV), { recursive: true });
	if (!headersExistentes) {
		const csv =
			headers.join(',') +
			'\n' +
			rows
				.map((r) => headers.map((h) => csvEscape(r[h])).join(','))
				.join('\n') +
			(rows.length ? '\n' : '');
		await writeFile(OUT_CSV, csv, { encoding: 'utf8', flag: 'wx' });
	} else if (rows.length) {
		const cols = headersExistentes;
		const prefixo = textoExistente.endsWith('\n') ? '' : '\n';
		const novas = rows
			.map((r) => cols.map((h) => csvEscape(r[h] ?? '')).join(','))
			.join('\n');
		await appendFile(OUT_CSV, `${prefixo}${novas}\n`, 'utf8');
	}

	console.log('\n=== Resumo ===');
	console.log(`já no CSV (preservadas): ${preservadas}`);
	console.log(`novas acrescentadas: ${rows.length}`);
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
