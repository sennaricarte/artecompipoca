/**
 * Levantamento de obras citadas em artigos publicados (cinema/séries).
 * Gera _recuperados/obras-citadas.csv — não altera conteúdo editorial.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT_DIR, '_recuperados');
const OUT_CSV = path.join(OUT_DIR, 'obras-citadas.csv');

const RESENHAS_DIR = path.join(ROOT_DIR, 'src/content/resenhas');
const ARTIGOS_DIR = path.join(ROOT_DIR, 'src/content/artigos');
const RECUPERADOS_MD = path.join(ROOT_DIR, '_recuperados/markdown');

const ARTICLES_PT = /^(o|a|os|as|um|uma|no|na|do|da|de|d)\s/i;
const MONTHS =
	/(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i;
const TITLE_TAIL_WORDS = new Set([
	'wars', 'trek', 'driver', 'note', 'gate', 'titan', 'kong', 'matrix', 'runner', 'boys', 'kings',
	'city', 'creek', 'sopranos', 'anatomy', 'office', 'lost', 'wire', 'bad', 'thrones', 'simpsons',
	'friends', 'proxy', 'kaiji', 'clones', 'sith', 'steel', 'superman', 'batman', 'demolidor',
]);

/** @param {string} s */
function stripAccents(s) {
	return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/** @param {string} s */
function normKey(s) {
	return stripAccents(s)
		.toLowerCase()
		.replace(/\(\s*(19|20)\d{2}[^)]*\)/g, '')
		.replace(/\b(19|20)\d{2}\b/g, '')
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** @param {string} raw */
function parseFrontmatter(raw) {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return { data: {}, body: raw };
	const block = m[1];
	const body = raw.slice(m[0].length).trimStart();
	/** @type {Record<string, unknown>} */
	const data = {};
	for (const line of block.split('\n')) {
		const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (!kv) continue;
		const [, key, valRaw] = kv;
		let val = valRaw.trim();
		if (val === 'true') data[key] = true;
		else if (val === 'false') data[key] = false;
		else if (/^\d+$/.test(val)) data[key] = Number(val);
		else if (val.startsWith('"') && val.endsWith('"')) data[key] = val.slice(1, -1);
		else data[key] = val;
	}
	const fichaBlock = block.match(/\nficha:\s*\n([\s\S]*?)(?=\n[A-Za-z_]+:|\n---|$)/);
	if (fichaBlock) {
		const fb = fichaBlock[1];
		data.ficha = {};
		const wikidata = fb.match(/wikidataId:\s*(Q\d+)/);
		if (wikidata) data.ficha.wikidataId = wikidata[1];
		if (/direcao:\s*\n\s*-\s+/m.test(fb)) data.ficha.direcao = true;
		if (/roteiro:\s*\n\s*-\s+/m.test(fb)) data.ficha.roteiro = true;
	}
	return { data, body };
}

/** @param {string} dir */
function listMd(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

/** @param {string} title */
function extractYear(title) {
	const paren = title.match(/\(\s*((?:19|20)\d{2})/);
	if (paren) return paren[1];
	const range = title.match(/\b((?:19|20)\d{2})\s*[–-]/);
	if (range) return range[1];
	const trailing = title.match(/\b((?:19|20)\d{2})\b/);
	if (trailing) return trailing[1];
	return '';
}

/** @param {string} title */
function cleanTitle(title) {
	return title
		.replace(/^#+\s*/, '')
		.replace(/\*\*/g, '')
		.replace(/\*/g, '')
		.replace(/^["'""«»]+|["'""«»]+$/g, '')
		.replace(/\s*\(\s*(?:19|20)\d{2}[^)]*\)\s*$/, '')
		.replace(/\s*\(\s*\d{1,2}\/\d{1,2}\)\s*$/, '')
		.replace(/\s*\(relançamento\)\s*$/i, '')
		.replace(/\s*\(Atualmente\)\s*$/i, '')
		.replace(/\s*[–-]\s*\d+\s*(?:ª|a)?\s*temporada.*$/i, '')
		.replace(/[.,;:!?…]+$/g, '')
		.trim();
}

/** @param {string} text */
function looksLikeSentence(text) {
	const t = cleanTitle(text);
	if (!t || t.length > 100) return true;
	if (/\?/.test(t)) return true;
	if (/^(?:Foi|Sou|Ninguém|Estive|Viram|Se houver|Mas o|Vocês|Odeio|Estava|Isso me|Afinal|Lembro|Compreendo)/i.test(t))
		return true;
	if (/,\s*(?:eu|ele|ela|ninguém|todos|mas|porque|quando|como)\s/i.test(t)) return true;
	if (/\b(?:disse|pergunt|reclam|credit|argument)\b/i.test(t)) return true;
	return false;
}

/** @param {string} text */
function stripNumberPrefix(text) {
	return text.replace(/^\d+\s*[–-]\s*/, '').trim();
}

/** @param {string} text */
function extractWorkFromPersonPrefix(text) {
	const em = text.match(/\bem\s+(.+)$/i);
	if (em) return cleanTitle(em[1]);
	return cleanTitle(text);
}

/** @param {string} text */
function looksLikePerson(text) {
	const t = cleanTitle(text);
	if (!t || t.length > 45) return false;
	if (/\d/.test(t) || /[–—:]/.test(t)) return false;
	if (ARTICLES_PT.test(t)) return false;
	if (/\([^)]*\)/.test(t)) return false;

	const words = t.split(/\s+/).filter(Boolean);
	if (words.length < 2 || words.length > 4) return false;

	const last = stripAccents(words[words.length - 1]).toLowerCase();
	if (TITLE_TAIL_WORDS.has(last)) return false;

	const nameLike = (w) =>
		/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-záéíóúâêôãõç]+(?:['-][A-Za-záéíóúâêôãõç]+)?$/.test(w) ||
		/^(de|da|do|dos|das|van|von|di|del|le|la)$/i.test(w);

	return words.every(nameLike);
}

/** @param {string} text */
function isSkipHeading(text) {
	const t = cleanTitle(text);
	if (!t) return true;
	if (/^(conheça|fontes|gênero|temporadas|sinopse|meio século|nota editorial)$/i.test(t)) return true;
	if (/^conheça\b/i.test(t)) return true;
	if (/^lista com/i.test(t)) return true;
	if (/^o que (?:ainda|já)\b/i.test(t)) return true;
	if (/^estreias mundiais\b/i.test(t)) return true;
	if (/^de \d+ a \d+ de\b/i.test(t)) return true;
	if (/^um filme que\b/i.test(t)) return true;
	if (/^do que trata\b/i.test(t)) return true;
	if (/^o calendário\b/i.test(t)) return true;
	if (/^mostra internacional de cinema\b/i.test(t)) return true;
	if (/^\d+ª edição$/i.test(t)) return true;
	if (/^george miller:/i.test(t)) return true;
	if (/^national board\b/i.test(t)) return true;
	if (/^vamos começar\b/i.test(t)) return true;
	if (/^cine belas artes\b/i.test(t)) return true;
	if (/^abertura com\b/i.test(t)) return true;
	if (/^maratona\b/i.test(t)) return true;
	if (/fest(?:ival)?\b/i.test(t) && !/\(\s*(19|20)\d{2}/.test(t)) return true;
	if (/^\d{1,2}\s*(?:º|°)?\s*(?:de\b|e\s+\d)/i.test(t)) return true;
	if (/^\d+\s+a\s+\d+\s+de/i.test(t)) return true;
	if (MONTHS.test(t) && /\d{4}/.test(t) && t.length < 40) return true;
	if (/^\d+\s*(?:º|°)?\s*de\s+\w+/i.test(t)) return true;
	if (/^[\d\sº°de]+$/i.test(t)) return true;
	return false;
}

/** @param {string} text */
function looksLikeWorkTitle(text) {
	const t = cleanTitle(text);
	if (t.length < 2 || t.length > 120) return false;
	if (looksLikeSentence(t)) return false;
	if (/^fontes$/i.test(t)) return false;
	if (/^(gênero|temporadas|sinopse)$/i.test(t)) return false;
	if (looksLikePerson(t)) return false;
	if (isSkipHeading(t)) return false;
	if (/^com\s+(?:suas|o|a|os|as)\b/i.test(t)) return false;
	if (/^de niro$/i.test(t)) return false;
	if (/\([^)]*de niro\)/i.test(t)) return false;
	if (/^, e o /i.test(t)) return false;
	if (/^sergio leone,\s*elia kazan$/i.test(t)) return false;
	if (/^you talkin/i.test(t)) return false;
	if (/^sindicato de ladr/i.test(t) && /direção|direcao/i.test(text)) return false;

	if (extractYear(text)) return true;
	if (ARTICLES_PT.test(t)) return true;
	if (/[,:]/.test(t)) return true;
	if (/\(\s*\d{1,2}\/\d{1,2}\s*\)/.test(text)) return true;
	if (/^\d/.test(t)) return true;
	if (/\bvs\.?\b/i.test(t)) return true;
	if (/^(the|star trek|game of thrones|breaking bad|death note|steins)/i.test(t)) return true;
	if (t.split(/\s+/).length >= 4) return true;

	return false;
}

/** @param {string} body @param {string} editoria */
function extractWorksFromArticle(body, editoria) {
	/** @type {{ titulo: string, ano: string, tipo: string }[]} */
	const found = [];
	const defaultTipo = editoria === 'series' ? 'série' : 'filme';

	/** @param {string} raw @param {string} context */
	function addWork(raw, context = '') {
		let titulo = stripNumberPrefix(extractWorkFromPersonPrefix(raw));
		if (!looksLikeWorkTitle(titulo) && !looksLikeWorkTitle(raw)) return;
		if (!looksLikeWorkTitle(titulo)) titulo = cleanTitle(stripNumberPrefix(raw));
		if (!looksLikeWorkTitle(titulo)) return;

		let tipo = defaultTipo;
		const ctx = (context + ' ' + raw + ' ' + titulo).toLowerCase();
		if (/\bsérie\b|\bseriado\b|\bserie\b|\btemporada\b|\bepisódio\b|\bepisodio\b|\banime\b/.test(ctx))
			tipo = 'série';
		if (/\bfilme\b|\blonga\b|\banimação\b|\banimacao\b/.test(ctx) && editoria !== 'series') tipo = 'filme';

		found.push({ titulo, ano: extractYear(raw + ' ' + titulo), tipo });
	}

	for (const line of body.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('>')) continue;

		const hm = trimmed.match(/^#{2,3}\s+(.+)$/);
		if (hm) {
			addWork(hm[1], trimmed);
			continue;
		}

		const listQuoted = trimmed.match(/^[-*]\s+\*\*"([^"]+)"(?:\s*\([^)]*\))?\*\*/);
		if (listQuoted) {
			addWork(listQuoted[1], trimmed);
			continue;
		}

		const listBold = trimmed.match(/^[-*]\s+\*\*([^*]+)\*\*/);
		if (listBold) {
			const inner = listBold[1].replace(/^Maratona\s+"([^"]+)".*$/i, '$1');
			if (!/^Hybe Cine Fest/i.test(inner)) addWork(inner, trimmed);
			continue;
		}

		for (const tri of trimmed.matchAll(/\*\*\*([^*\n]{2,100})\*\*\*/g)) {
			const chunk = tri[1].trim();
			if (looksLikeWorkTitle(chunk)) addWork(chunk, trimmed);
		}

		for (const b of trimmed.matchAll(/\*\*([^*\n]{2,100})\*\*/g)) {
			const chunk = b[1].trim();
			if (/^(?:Direção de|Gênero|Temporadas|Divulgação|Hayden Christensen|Natalie Portman|Atores|Vamos começar|Universo DC|Ben Affleck|Bruce Wayne|Christopher Nolan|Marvel Studios|Capitão América|DC Comics|George Lucas|Zack Snyder|Lex Luthor|General Zod|Henry Cavill|Jared Leto|Charles Bronson|Dick Cheney|Joe Shuster|Jerry Siegel|John Byrne|Frank Miller|Gal Gadot|Robert Pattinson|Chris Evans|Heath Ledger|Daniel Craig|Jennifer Garner|Colin Farrell|Samuel L\. Jackson|Liam Neeson|Ewan McGregor|Mike Nichols|Sofia Coppola|Nicolas Cage|Marquês de Pombal|Ennio Morricone|Martin Scorsese|Elia Kazan|Brian De Palma|Sergio Leone|Roland Joffé|Bernardo Bertolucci|Stanley Kubrick|Fritz Lang|Philip K Dick|David Lynch|Walter Salles|Lars Von Trier|Abbas Kiarostami|Michael Haneke|Josef von Sternberg|James Gray|Akira Kurosawa|Aaron Sorkin|Leon Cakoff|Renata de Almeida|Daniela Thomas|Maurice Pialat|Kazuo Ishiguro|Jeff Horwitz|Mark Zuckerberg|Mikey Madison|Jeremy Allen White|Jeremy Strong|Andrew Koji|Noah Centineo|Michael Jordan|Ozzy Osbourne|Thomas Mann|Erika Mann|Frances Haugen|Jeff Horwitz)$/i.test(chunk))
				continue;
			if (/^\d+\s*[–-]/.test(chunk)) addWork(chunk, trimmed);
			else if (looksLikeWorkTitle(chunk)) addWork(chunk, trimmed);
		}

		for (const it of trimmed.matchAll(/(?<!\*)\*([^*\n]{3,80})\*(?!\*)/g)) {
			const chunk = it[1].replace(/^["']|["']$/g, '').trim();
			if (/^(?:AutoReivs|killer|raison d'être|prequel)$/i.test(chunk)) continue;
			if (looksLikeWorkTitle(chunk)) addWork(chunk, trimmed);
		}

		if (/^[-*]\s/.test(trimmed)) {
			for (const q of trimmed.matchAll(/"([^"]{2,100})"/g)) {
				if (/^(?:You talkin' to me\?|Bobby Milk|Little Italy|Sétima Arte|Tigre de Papel|Ad Astra|Clarissa|La Maison des Bois)$/i.test(q[1]))
					continue;
				addWork(q[1], trimmed);
			}
		}
	}

	return found;
}

/** @param {string} dir @param {boolean} recursive */
function collectMdFiles(dir, recursive = false) {
	if (!fs.existsSync(dir)) return [];
	/** @type {string[]} */
	const out = [];
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory() && recursive) out.push(...collectMdFiles(full, true));
		else if (ent.isFile() && ent.name.endsWith('.md')) out.push(full);
	}
	return out;
}

/** @param {string} filePath @param {string} source */
function readResenha(filePath, source = 'content') {
	const raw = fs.readFileSync(filePath, 'utf8');
	const { data } = parseFrontmatter(raw);
	return {
		file: path.basename(filePath),
		slug: path.basename(filePath, '.md'),
		obra: String(data.obra || ''),
		tipo: String(data.tipo || ''),
		draft: Boolean(data.draft),
		ficha: data.ficha,
		source,
	};
}

/** @param {{ ficha?: { wikidataId?: string, direcao?: boolean, roteiro?: boolean }, tipo: string }} resenha */
function hasFichaTecnica(resenha) {
	if (!resenha.ficha) return false;
	if (resenha.ficha.wikidataId) return true;
	if (resenha.tipo === 'hq' || resenha.tipo === 'album') return Boolean(resenha.ficha.roteiro);
	return Boolean(resenha.ficha.direcao || resenha.ficha.roteiro);
}

function csvEscape(val) {
	const s = String(val ?? '');
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

// --- Resenhas ---
const resenhaFiles = listMd(RESENHAS_DIR).map((f) => path.join(RESENHAS_DIR, f));
const allResenhas = resenhaFiles.map((f) => readResenha(f));
const publishedResenhas = allResenhas.filter((r) => !r.draft);

const recuperadosFiles = collectMdFiles(RECUPERADOS_MD, true);
for (const fp of recuperadosFiles) {
	const r = readResenha(fp, 'recuperados');
	if (r.obra && r.tipo) {
		r.draft = true;
		allResenhas.push(r);
	}
}

const semFicha = publishedResenhas.filter((r) => !hasFichaTecnica(r));

/** @type {{ key: string, publicada: boolean, rascunho: boolean, obra: string }[]} */
const reviewEntries = [];
for (const r of allResenhas) {
	const key = normKey(r.obra);
	if (!key) continue;
	reviewEntries.push({
		key,
		obra: r.obra,
		publicada: !r.draft && r.source === 'content',
		rascunho: r.draft || r.source === 'recuperados',
	});
}

/** @param {string} citedTitle */
function situacaoForTitle(citedTitle) {
	const key = normKey(citedTitle);
	if (!key || key.length < 3) return 'sem_critica';

	let publicada = false;
	let rascunho = false;

	for (const r of reviewEntries) {
		const rk = r.key;
		const match =
			rk === key ||
			(key.length >= 6 && rk.includes(key)) ||
			(rk.length >= 6 && key.includes(rk));
		if (!match) continue;
		if (r.publicada) publicada = true;
		if (r.rascunho) rascunho = true;
	}

	if (publicada) return 'publicada';
	if (rascunho) return 'rascunho';
	return 'sem_critica';
}

// --- Artigos publicados (cinema + séries) ---
const artigoFiles = listMd(ARTIGOS_DIR)
	.map((f) => path.join(ARTIGOS_DIR, f))
	.filter((fp) => {
		const { data } = parseFrontmatter(fs.readFileSync(fp, 'utf8'));
		return !data.draft && (data.editoria === 'cinema' || data.editoria === 'series');
	});

/** @type {Map<string, { titulo: string, ano: string, tipo: string, artigos: Set<string>, count: number }>} */
const obrasMap = new Map();

for (const fp of artigoFiles) {
	const raw = fs.readFileSync(fp, 'utf8');
	const { data, body } = parseFrontmatter(raw);
	const editoria = String(data.editoria || 'cinema');
	const slug = path.basename(fp, '.md');
	const works = extractWorksFromArticle(body, editoria);
	for (const w of works) {
		const key = normKey(w.titulo);
		if (!key || key.length < 2) continue;
		const cur = obrasMap.get(key) || {
			titulo: w.titulo,
			ano: w.ano,
			tipo: w.tipo,
			artigos: new Set(),
			count: 0,
		};
		cur.count += 1;
		cur.artigos.add(slug);
		if (w.ano && !cur.ano) cur.ano = w.ano;
		const curHasPerson = /\bem\s+[A-ZÁÉÍÓÚ]/i.test(cur.titulo);
		const newHasPerson = /\bem\s+[A-ZÁÉÍÓÚ]/i.test(w.titulo);
		if (curHasPerson && !newHasPerson) cur.titulo = w.titulo;
		else if (!curHasPerson && !newHasPerson && w.titulo.length > cur.titulo.length)
			cur.titulo = w.titulo;
		else if (!curHasPerson && newHasPerson) {
			/* mantém título sem prefixo de pessoa */
		} else if (curHasPerson && newHasPerson && w.titulo.length > cur.titulo.length) cur.titulo = w.titulo;
		if (w.tipo === 'série') cur.tipo = 'série';
		obrasMap.set(key, cur);
	}
}

const rows = [...obrasMap.entries()]
	.map(([key, v]) => ({
		obra: v.titulo,
		ano_citado: v.ano,
		tipo_provavel: v.tipo,
		artigos: [...v.artigos].sort().join('|'),
		quantidade_de_citacoes: v.count,
		situacao: situacaoForTitle(v.titulo),
		key,
	}))
	.sort(
		(a, b) =>
			b.quantidade_de_citacoes - a.quantidade_de_citacoes ||
			a.obra.localeCompare(b.obra, 'pt'),
	);

fs.mkdirSync(OUT_DIR, { recursive: true });
const header = 'obra,ano_citado,tipo_provavel,artigos,quantidade_de_citacoes,situacao\n';
const csvBody = rows
	.map((r) =>
		[
			csvEscape(r.obra),
			csvEscape(r.ano_citado),
			csvEscape(r.tipo_provavel),
			csvEscape(r.artigos),
			r.quantidade_de_citacoes,
			csvEscape(r.situacao),
		].join(','),
	)
	.join('\n');
fs.writeFileSync(OUT_CSV, header + csvBody + '\n', 'utf8');

const situCounts = { publicada: 0, rascunho: 0, sem_critica: 0 };
for (const r of rows) situCounts[r.situacao]++;

console.log(
	JSON.stringify(
		{
			totalObras: rows.length,
			situCounts,
			top20: rows.slice(0, 20).map(({ key, ...r }) => r),
			semFicha: semFicha.map((r) => ({ arquivo: r.file, obra: r.obra, tipo: r.tipo })),
			publishedResenhas: publishedResenhas.length,
			publishedArtigos: artigoFiles.length,
			recuperadosResenhas: allResenhas.filter((r) => r.source === 'recuperados').length,
		},
		null,
		2,
	),
);
