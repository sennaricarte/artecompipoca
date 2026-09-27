/**
 * Cliente Wikidata compartilhado (busca, entidades, pontuação).
 */

export const USER_AGENT =
	'ArteComPipocaBot/1.0 (https://artecompipoca.net; contato@artecompipoca.net)';
export const SEARCH_URL = 'https://www.wikidata.org/w/api.php';
export const SPARQL_URL = 'https://query.wikidata.org/sparql';

export const CLASSE_FILME = 'Q11424';
export const CLASSE_FILME_ANIMACAO = 'Q202866';
export const CLASSE_LONGA_ANIMACAO = 'Q29168811';
export const CLASSE_SERIE = 'Q5398426';
export const CLASSE_MINISSERIE = 'Q1259759';
export const CLASSE_SERIE_ANIMADA = 'Q581714';
export const CLASSE_SITCOM = 'Q15416';
export const CLASSE_SITCOM_ANIMADA = 'Q7696995';
export const CLASSES_FILME = [CLASSE_FILME, CLASSE_FILME_ANIMACAO, CLASSE_LONGA_ANIMACAO];
export const CLASSES_SERIE = [
	CLASSE_SERIE,
	CLASSE_SERIE_ANIMADA,
	CLASSE_MINISSERIE,
	CLASSE_SITCOM,
	CLASSE_SITCOM_ANIMADA,
];

export const DELAY_MS = 1000;

/**
 * @param {number} ms
 */
export function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [attempt]
 */
export async function fetchRetry(url, init = {}, attempt = 0) {
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
 * @param {string} s
 */
export function normalize(s) {
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
export function yearFromTitle(title) {
	const m = String(title).match(/\((\d{4})\)/);
	return m ? Number(m[1]) : null;
}

/**
 * @param {string} obra
 */
export function simplifyObra(obra) {
	return String(obra || '')
		.replace(/\s*\(\d{4}\)\s*/g, ' ')
		.replace(/^(O|A|Os|As)\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * @param {string} obra
 * @param {string} classId
 * @returns {Promise<string[]>}
 */
export async function searchByClass(obra, classId) {
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
 * @param {string} obra
 * @param {string[]} classIds
 * @returns {Promise<string[]>}
 */
export async function searchByClasses(obra, classIds) {
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
export async function searchIds(obra, tipo) {
	/** @param {string} q */
	async function once(q) {
		if (tipo === 'filme') {
			return searchByClasses(q, CLASSES_FILME);
		}
		return searchByClasses(q, CLASSES_SERIE);
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
 * @param {string} term
 * @param {'filme' | 'serie'} tipo
 */
export async function searchByTipo(term, tipo) {
	if (tipo === 'filme') return searchByClasses(term, CLASSES_FILME);
	return searchByClasses(term, CLASSES_SERIE);
}

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string, any>>}
 */
export async function wbgetentities(ids) {
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
export function pickLabel(entity, langs = ['pt-br', 'pt', 'en']) {
	const labels = entity?.labels || {};
	for (const lang of langs) {
		if (labels[lang]?.value) return labels[lang].value;
	}
	const any = Object.values(labels)[0];
	return any?.value || entity?.id || '';
}

/**
 * @param {any} entity
 */
export function collectTitulos(entity) {
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
export function claimEntityIds(entity, prop) {
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
export function claimYear(entity, prop) {
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
export function claimQuantity(entity, prop) {
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
export async function fetchCandidatesData(ids, tipo) {
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
			anoFim: claimYear(ent, 'P582'),
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
export function scoreCandidate(cand, ctx) {
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
	if (cand.ano != null && anosRef.some((y) => y === cand.ano)) {
		score += 4;
	}
	if (ctx.anoObra != null && cand.anoInicio != null && cand.anoInicio === ctx.anoObra) {
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
export function confiancaAlta(best, second, scored) {
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
 * @param {any} cand
 * @param {'filme' | 'serie'} tipo
 */
export function anoParaSegundaBusca(cand, tipo) {
	if (tipo === 'serie') {
		return cand.anoInicio ?? cand.ano ?? null;
	}
	return cand.ano ?? null;
}

/**
 * @param {string} id
 * @param {'filme' | 'serie'} tipo
 */
export async function entityMatchesTipo(id, tipo) {
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
