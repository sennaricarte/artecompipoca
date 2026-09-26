#!/usr/bin/env node
/**
 * Capas para resenhas a partir de fotos com licença livre do Wikimedia Commons.
 *
 * Para cada resenha publicada com ficha.wikidataId e sem cover, busca no Wikidata
 * a foto (P18) dos diretores (P57) e, se nenhum tiver, dos três primeiros do elenco
 * (P161). Só aceita Public domain, CC0, CC BY e CC BY-SA (qualquer versão).
 *
 * Uso:
 *   pnpm fotos:commons            gera _recuperados/fotos-candidatas.csv (e fotos-rejeitadas.csv)
 *   pnpm fotos:commons --apply    processa as linhas com aprovar = sim
 *
 * Com --apply: baixa para src/assets/capas/{id}.jpg (nunca sobrescreve) e grava
 * cover, coverAlt, coverCredito e coverLicencaUrl no frontmatter.
 *
 * Boas práticas da Wikimedia: User-Agent identificado, uma requisição por vez,
 * 1 segundo entre chamadas.
 */

import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RESENHAS_DIR = join(ROOT, 'src', 'content', 'resenhas');
const CAPAS_DIR = join(ROOT, 'src', 'assets', 'capas');
const CSV_CANDIDATAS = join(ROOT, '_recuperados', 'fotos-candidatas.csv');
const CSV_REJEITADAS = join(ROOT, '_recuperados', 'fotos-rejeitadas.csv');
const APPLY = process.argv.includes('--apply');

const USER_AGENT =
	'ArteComPipocaBot/1.0 (https://artecompipoca.net; contato@artecompipoca.net)';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const INTERVALO_MS = 1000;
/** Largura da versão baixada: suficiente para a capa (800px) e o OG (1200px). */
const LARGURA_DOWNLOAD = 1600;
const MAX_ELENCO = 3;
/** Abaixo disso a foto fica borrada na capa (800px): buscar alternativas na categoria. */
const LARGURA_MINIMA = 800;
const LARGURA_ALTERNATIVA = 1000;
const MAX_ALTERNATIVAS = 3;
const MAX_AUTOR = 40;
const FEMININO = new Set(['Q6581072', 'Q1052281']);

const COLUNAS = [
	'arquivo',
	'obra',
	'pessoa',
	'papel',
	'arquivo_commons',
	'licenca',
	'autor',
	'dimensoes',
	'pessoa_wikidata',
	'alternativa_1',
	'alternativa_2',
	'alternativa_3',
	'aprovar',
];

// ---------- rede (uma requisição por vez, 1 s entre chamadas) ----------

let ultimaChamada = 0;

async function pausar() {
	const espera = ultimaChamada + INTERVALO_MS - Date.now();
	if (espera > 0) await new Promise((r) => setTimeout(r, espera));
	ultimaChamada = Date.now();
}

async function buscar(url) {
	await pausar();
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) throw new Error(`${res.status} em ${url}`);
	return res;
}

async function buscarJson(base, params) {
	const res = await buscar(`${base}?${new URLSearchParams({ format: 'json', ...params })}`);
	return res.json();
}

// ---------- Wikidata ----------

async function entidades(ids, props = 'claims|labels') {
	if (ids.length === 0) return {};
	const json = await buscarJson(WIKIDATA_API, {
		action: 'wbgetentities',
		ids: ids.join('|'),
		props,
		languages: 'pt-br|pt|en',
	});
	return json.entities ?? {};
}

function valoresClaim(entidade, prop) {
	return (entidade?.claims?.[prop] ?? [])
		.filter((c) => c.rank !== 'deprecated')
		.map((c) => c.mainsnak?.datavalue?.value)
		.filter(Boolean);
}

function rotulo(entidade) {
	const l = entidade?.labels ?? {};
	return (l['pt-br'] ?? l.pt ?? l.en)?.value;
}

// ---------- Commons ----------

/** Public domain, CC0, CC BY e CC BY-SA, em qualquer versão ou jurisdição. */
function licencaAceita(licenca) {
	const l = licenca.trim().toLowerCase();
	if (/^(public domain|pd)\b/.test(l)) return true;
	if (/^cc0\b/.test(l)) return true;
	return /^cc[ -]by(-sa)?(\s+\d(\.\d)?)?(\s+[a-z-]+)?$/.test(l);
}

function semHtml(html) {
	return String(html ?? '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/\s+/g, ' ')
		.trim();
}

function lerImageinfo(info) {
	const meta = info.extmetadata ?? {};
	return {
		url: info.url,
		thumbUrl: info.thumburl ?? info.url,
		paginaUrl: info.descriptionurl,
		mime: info.mime,
		largura: info.width,
		altura: info.height,
		licenca: semHtml(meta.LicenseShortName?.value) || '(sem licença)',
		licencaUrl: semHtml(meta.LicenseUrl?.value) || undefined,
		autor: semHtml(meta.Artist?.value) || 'autor desconhecido',
	};
}

async function infoCommons(arquivo) {
	const json = await buscarJson(COMMONS_API, {
		action: 'query',
		titles: `File:${arquivo}`,
		prop: 'imageinfo',
		iiprop: 'url|size|mime|extmetadata',
		iiurlwidth: String(LARGURA_DOWNLOAD),
	});
	const pagina = Object.values(json.query?.pages ?? {})[0];
	const info = pagina?.imageinfo?.[0];
	return info ? lerImageinfo(info) : null;
}

/**
 * Fotos maiores da mesma pessoa na categoria do Commons (P373 ou o nome), com as
 * mesmas licenças aceitas. Prioriza arquivos com o sobrenome no título (retratos).
 */
async function alternativas(pessoa, nome, original) {
	const categoria = valoresClaim(pessoa, 'P373')[0] ?? nome;
	const json = await buscarJson(COMMONS_API, {
		action: 'query',
		generator: 'categorymembers',
		gcmtitle: `Category:${categoria}`,
		gcmtype: 'file',
		gcmlimit: '50',
		prop: 'imageinfo',
		iiprop: 'url|size|mime|extmetadata',
	});
	const sobrenome = nome.split(/\s+/).at(-1)?.toLowerCase() ?? '';
	return Object.values(json.query?.pages ?? {})
		.map((p) => ({ arquivo: p.title.replace(/^File:/, ''), info: p.imageinfo?.[0] }))
		.filter((p) => p.info && p.arquivo !== original)
		.map((p) => ({ arquivo: p.arquivo, ...lerImageinfo(p.info) }))
		.filter(
			(a) =>
				/^image\/(jpeg|png|webp)$/.test(a.mime ?? '') &&
				a.largura >= LARGURA_ALTERNATIVA &&
				licencaAceita(a.licenca),
		)
		.sort((a, b) => {
			const pa = a.arquivo.toLowerCase().includes(sobrenome) ? 0 : 1;
			const pb = b.arquivo.toLowerCase().includes(sobrenome) ? 0 : 1;
			return pa - pb || a.arquivo.localeCompare(b.arquivo);
		})
		.slice(0, MAX_ALTERNATIVAS)
		.map((a) => ({
			arquivo: a.arquivo,
			celula: `${a.arquivo} | ${a.licenca} | ${a.largura}x${a.altura} | ${a.paginaUrl}`,
		}));
}

// ---------- resenhas ----------

function separarFrontmatter(conteudo) {
	const m = conteudo.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!m) throw new Error('frontmatter não encontrado');
	return { yaml: m[1], resto: conteudo.slice(m[0].length) };
}

function lerCampo(yaml, chave) {
	const m = yaml.match(new RegExp(`^${chave}:[ \\t]*(.+)$`, 'm'));
	return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2') : undefined;
}

async function lerResenhas() {
	const lista = [];
	for (const nome of (await readdir(RESENHAS_DIR)).sort()) {
		if (!/\.mdx?$/.test(nome)) continue;
		const caminho = join(RESENHAS_DIR, nome);
		const { yaml } = separarFrontmatter(await readFile(caminho, 'utf8'));
		lista.push({
			arquivo: nome,
			caminho,
			id: basename(nome, extname(nome)),
			obra: lerCampo(yaml, 'obra') ?? lerCampo(yaml, 'title') ?? nome,
			publicado: lerCampo(yaml, 'draft') === 'false',
			temCover: /^cover:/m.test(yaml),
			wikidataId: yaml.match(/^[ \t]+wikidataId:[ \t]*["']?(Q\d+)/m)?.[1],
		});
	}
	return lista;
}

function definirCampos(yaml, campos) {
	const chaves = Object.keys(campos);
	const linhas = yaml.split(/\r?\n/).filter((l) => !chaves.some((c) => l.startsWith(`${c}:`)));
	const idxTipo = linhas.findIndex((l) => l.startsWith('tipo:'));
	const novas = chaves
		.filter((c) => campos[c] != null)
		.map((c) => `${c}: ${JSON.stringify(campos[c])}`);
	linhas.splice(idxTipo >= 0 ? idxTipo + 1 : linhas.length, 0, ...novas);
	return linhas.join('\n');
}

// ---------- CSV ----------

function csvCelula(v) {
	const s = String(v ?? '');
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serializarCsv(colunas, linhas) {
	return `${[colunas, ...linhas.map((l) => colunas.map((c) => l[c]))]
		.map((l) => l.map(csvCelula).join(','))
		.join('\n')}\n`;
}

function lerCsv(texto) {
	const registros = [];
	let campo = '';
	let registro = [];
	let aspas = false;
	const t = texto.replace(/^\uFEFF/, '');
	for (let i = 0; i < t.length; i++) {
		const ch = t[i];
		if (aspas) {
			if (ch === '"' && t[i + 1] === '"') {
				campo += '"';
				i++;
			} else if (ch === '"') aspas = false;
			else campo += ch;
		} else if (ch === '"') aspas = true;
		else if (ch === ',') {
			registro.push(campo);
			campo = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && t[i + 1] === '\n') i++;
			registro.push(campo);
			if (registro.some((c) => c !== '')) registros.push(registro);
			registro = [];
			campo = '';
		} else campo += ch;
	}
	if (campo !== '' || registro.length) {
		registro.push(campo);
		registros.push(registro);
	}
	const [cab = [], ...resto] = registros;
	return resto.map((r) => Object.fromEntries(cab.map((c, i) => [c, r[i] ?? ''])));
}

async function existe(caminho) {
	try {
		await access(caminho);
		return true;
	} catch {
		return false;
	}
}

// ---------- varredura ----------

async function candidatos(resenha, rejeitadas) {
	const filme = (await entidades([resenha.wikidataId], 'claims'))[resenha.wikidataId];
	if (!filme) {
		rejeitadas.push({ ...resenha, motivo: `entidade ${resenha.wikidataId} não encontrada` });
		return null;
	}
	const diretores = valoresClaim(filme, 'P57').map((v) => v.id);
	const elenco = valoresClaim(filme, 'P161')
		.map((v) => v.id)
		.slice(0, MAX_ELENCO);
	const pessoas = await entidades([...new Set([...diretores, ...elenco])]);

	const grupos = [
		{ papel: 'direção', ids: diretores },
		{ papel: 'elenco', ids: elenco },
	];
	for (const { papel, ids } of grupos) {
		const comFoto = ids
			.map((id) => ({ id, entidade: pessoas[id] }))
			.filter((p) => valoresClaim(p.entidade, 'P18').length > 0);
		for (const p of comFoto) {
			const arquivo = valoresClaim(p.entidade, 'P18')[0];
			const nome = rotulo(p.entidade) ?? p.id;
			const info = await infoCommons(arquivo);
			if (!info) {
				rejeitadas.push({ ...resenha, pessoa: nome, arquivo_commons: arquivo, motivo: 'arquivo não encontrado no Commons' });
				continue;
			}
			if (!licencaAceita(info.licenca)) {
				rejeitadas.push({ ...resenha, pessoa: nome, arquivo_commons: arquivo, licenca: info.licenca, motivo: 'licença não aceita' });
				continue;
			}
			const alts =
				info.largura < LARGURA_MINIMA ? await alternativas(p.entidade, nome, arquivo) : [];
			return {
				arquivo: resenha.arquivo,
				obra: resenha.obra,
				pessoa: nome,
				papel,
				arquivo_commons: arquivo,
				licenca: info.licenca,
				autor: info.autor,
				dimensoes: `${info.largura}x${info.altura}`,
				pessoa_wikidata: p.id,
				alternativa_1: alts[0]?.celula ?? '',
				alternativa_2: alts[1]?.celula ?? '',
				alternativa_3: alts[2]?.celula ?? '',
				alternativasArquivos: alts.map((a) => a.arquivo),
				aprovar: '',
			};
		}
		// Só recorre ao elenco quando nenhum diretor tem foto.
		if (papel === 'direção' && comFoto.length > 0) break;
	}
	rejeitadas.push({ ...resenha, motivo: 'nenhuma foto aceitável de diretor ou dos 3 primeiros do elenco' });
	return null;
}

async function varrer() {
	const alvo = (await lerResenhas()).filter((r) => r.publicado && r.wikidataId && !r.temCover);
	console.log(`fotos-commons: ${alvo.length} resenhas publicadas com wikidataId e sem cover.`);

	const anteriores = (await existe(CSV_CANDIDATAS))
		? lerCsv(await readFile(CSV_CANDIDATAS, 'utf8'))
		: [];
	const anteriorPorArquivo = new Map(anteriores.map((l) => [l.arquivo, l]));

	const linhas = [];
	const rejeitadas = [];
	for (const [i, resenha] of alvo.entries()) {
		process.stdout.write(`  [${i + 1}/${alvo.length}] ${resenha.id}… `);
		try {
			const c = await candidatos(resenha, rejeitadas);
			if (c) {
				const anterior = anteriorPorArquivo.get(c.arquivo);
				// Mantém a aprovação e uma troca manual por uma das alternativas.
				if (anterior?.arquivo_commons === c.arquivo_commons) {
					c.aprovar = anterior.aprovar;
				} else if (anterior && c.alternativasArquivos.includes(anterior.arquivo_commons)) {
					c.arquivo_commons = anterior.arquivo_commons;
					c.aprovar = anterior.aprovar;
				}
				linhas.push(c);
				const nAlt = c.alternativasArquivos.length;
				console.log(
					`${c.pessoa} (${c.licenca}, ${c.dimensoes})${c.alternativa_1 || Number(c.dimensoes.split('x')[0]) >= LARGURA_MINIMA ? '' : ', sem alternativa'}${nAlt ? `, ${nAlt} alternativa(s)` : ''}`,
				);
			} else console.log('sem candidata');
		} catch (err) {
			rejeitadas.push({ ...resenha, motivo: `erro: ${err.message}` });
			console.log(`erro: ${err.message}`);
		}
	}

	await mkdir(dirname(CSV_CANDIDATAS), { recursive: true });
	await writeFile(CSV_CANDIDATAS, serializarCsv(COLUNAS, linhas));
	await writeFile(
		CSV_REJEITADAS,
		serializarCsv(['arquivo', 'obra', 'pessoa', 'arquivo_commons', 'licenca', 'motivo'], rejeitadas),
	);

	const porLicenca = {};
	for (const l of linhas) porLicenca[l.licenca] = (porLicenca[l.licenca] ?? 0) + 1;
	const semCandidata = alvo.length - linhas.length;
	const licencasRecusadas = rejeitadas.filter((r) => r.motivo === 'licença não aceita');

	console.log('\nResumo');
	console.log(`  Resenhas com candidata: ${linhas.length}`);
	console.log(`    por direção: ${linhas.filter((l) => l.papel === 'direção').length}, por elenco: ${linhas.filter((l) => l.papel === 'elenco').length}`);
	for (const [lic, n] of Object.entries(porLicenca).sort((a, b) => b[1] - a[1])) {
		console.log(`    ${lic}: ${n}`);
	}
	console.log(`  Resenhas sem candidata: ${semCandidata}`);
	console.log(`  Fotos puladas por licença não aceita: ${licencasRecusadas.length}`);
	console.log(`\n${relative(ROOT, CSV_CANDIDATAS)} e ${relative(ROOT, CSV_REJEITADAS)} gravados.`);
	console.log('Marque aprovar = sim nas linhas desejadas e rode com --apply.');
}

// ---------- aplicação ----------

function truncar(texto, max) {
	return texto.length <= max ? texto : `${texto.slice(0, max - 1).trimEnd()}…`;
}

async function baixarJpeg(url, destino) {
	const res = await buscar(url);
	let buf = Buffer.from(await res.arrayBuffer());
	const ext = extname(new URL(url).pathname).toLowerCase();
	if (ext !== '.jpg' && ext !== '.jpeg') {
		const { default: sharp } = await import('sharp');
		buf = await sharp(buf).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer();
	}
	await mkdir(CAPAS_DIR, { recursive: true });
	await writeFile(destino, buf, { flag: 'wx' });
}

async function aplicar() {
	if (!(await existe(CSV_CANDIDATAS))) {
		throw new Error(`${relative(ROOT, CSV_CANDIDATAS)} não existe; rode sem --apply primeiro`);
	}
	const aprovadas = lerCsv(await readFile(CSV_CANDIDATAS, 'utf8')).filter(
		(l) => l.aprovar.trim().toLowerCase() === 'sim',
	);
	console.log(`fotos-commons --apply: ${aprovadas.length} linha(s) aprovada(s).`);

	for (const linha of aprovadas) {
		const caminho = join(RESENHAS_DIR, linha.arquivo);
		const id = basename(linha.arquivo, extname(linha.arquivo));
		const destino = join(CAPAS_DIR, `${id}.jpg`);
		const conteudo = await readFile(caminho, 'utf8');
		const { yaml, resto } = separarFrontmatter(conteudo);
		if (/^cover:/m.test(yaml)) {
			console.log(`  ${id}: já tem cover, pulado.`);
			continue;
		}

		const info = await infoCommons(linha.arquivo_commons);
		if (!info || !licencaAceita(info.licenca)) {
			console.log(`  ${id}: licença atual "${info?.licenca ?? '?'}" não aceita, pulado.`);
			continue;
		}

		const pessoa = (await entidades([linha.pessoa_wikidata], 'claims'))[linha.pessoa_wikidata];
		const feminino = valoresClaim(pessoa, 'P21').some((v) => FEMININO.has(v.id));
		const funcao =
			linha.papel === 'direção' ? (feminino ? 'diretora' : 'diretor') : feminino ? 'atriz' : 'ator';

		if (await existe(destino)) {
			console.log(`  ${id}: ${relative(ROOT, destino)} já existe, imagem mantida.`);
		} else {
			await baixarJpeg(info.thumbUrl, destino);
			console.log(`  ${id}: baixado ${relative(ROOT, destino)}`);
		}

		const coverRel = relative(dirname(caminho), destino).replace(/\\/g, '/');
		const campos = {
			cover: coverRel.startsWith('.') ? coverRel : `./${coverRel}`,
			coverAlt: `${linha.pessoa}, ${funcao} de ${linha.obra}`,
			coverCredito: `Foto: ${truncar(info.autor, MAX_AUTOR)} / ${info.licenca} / Wikimedia Commons`,
			coverLicencaUrl: info.licencaUrl,
		};
		const eol = conteudo.includes('\r\n') ? '\r\n' : '\n';
		const novoYaml = definirCampos(yaml, campos).replace(/\r?\n/g, eol);
		await writeFile(caminho, `---${eol}${novoYaml}${eol}---${eol}${resto}`);
		console.log(`  ${id}: frontmatter atualizado (${campos.coverCredito})`);
	}
}

(APPLY ? aplicar() : varrer()).catch((err) => {
	console.error('fotos-commons falhou:', err.message ?? err);
	process.exitCode = 1;
});
