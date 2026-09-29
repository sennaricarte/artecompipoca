import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { getCollection } from 'astro:content';

const AUTORES_SEM_FRASE_FACTUAL = new Set(['senna-ricarte', 'redacao']);
// Não ler _recuperados/markdown em build — Vercel não disponibiliza essa pasta.

type AutorResumo = {
	anoInicial: number;
	anoFinal: number;
	totalPublicados: number;
};

let autoresResumoPromise: Promise<Map<string, AutorResumo>> | null = null;

/**
 * @param {string} raw
 * @returns {Record<string, string>}
 */
function extrairFrontmatter(raw: string): Record<string, string> {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};

	/** @type {Record<string, string>} */
	const data: Record<string, string> = {};
	for (const linha of match[1].split(/\r?\n/)) {
		if (!linha || /^\s/.test(linha)) continue;
		const campo = linha.match(/^([A-Za-z][\w-]*):\s*(.+)$/);
		if (!campo) continue;
		data[campo[1]] = campo[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return data;
}

/**
 * @param {string} valor
 * @returns {number | null}
 */
function extrairAno(valor: string): number | null {
	const match = valor.match(/\b(\d{4})\b/);
	return match ? Number(match[1]) : null;
}

/**
 * @param {Map<string, AutorResumo>} mapa
 * @param {string} autorId
 * @param {number} ano
 * @param {boolean} publicado
 */
function acumularAutor(
	mapa: Map<string, AutorResumo>,
	autorId: string,
	ano: number,
	publicado: boolean,
) {
	const atual = mapa.get(autorId) ?? {
		anoInicial: ano,
		anoFinal: ano,
		totalPublicados: 0,
	};

	atual.anoInicial = Math.min(atual.anoInicial, ano);
	atual.anoFinal = Math.max(atual.anoFinal, ano);
	if (publicado) atual.totalPublicados += 1;
	mapa.set(autorId, atual);
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listarArquivosMarkdown(dir: string): Promise<string[]> {
	const itens = await readdir(dir, { withFileTypes: true });
	const arquivos = await Promise.all(
		itens.map(async (item) => {
			const caminho = join(dir, item.name);
			if (item.isDirectory()) return listarArquivosMarkdown(caminho);
			return ['.md', '.mdx'].includes(extname(item.name)) ? [caminho] : [];
		}),
	);
	return arquivos.flat();
}

async function carregarAutoresResumo(): Promise<Map<string, AutorResumo>> {
	const [artigos, resenhas] = await Promise.all([
		getCollection('artigos'),
		getCollection('resenhas'),
	]);

	const mapa = new Map<string, AutorResumo>();

	for (const entry of [...artigos, ...resenhas]) {
		acumularAutor(
			mapa,
			entry.data.autor.id,
			entry.data.pubDate.getUTCFullYear(),
			!entry.data.draft,
		);
	}
	return mapa;
}

async function getAutoresResumoMap() {
	if (!autoresResumoPromise) {
		autoresResumoPromise = carregarAutoresResumo();
	}
	return autoresResumoPromise;
}

export async function getResumoAutor(autorId: string, bioBase = '') {
	const mapa = await getAutoresResumoMap();
	const resumo = mapa.get(autorId);

	let fraseFactual = '';
	if (resumo && !AUTORES_SEM_FRASE_FACTUAL.has(autorId)) {
		const anoIni = Math.max(2013, resumo.anoInicial);
		fraseFactual =
			anoIni === resumo.anoFinal
				? `Colaborou com o Arte Com Pipoca em ${anoIni}.`
				: `Colaborou com o Arte Com Pipoca entre ${anoIni} e ${resumo.anoFinal}.`;
	}

	const bioCompleta = [bioBase.trim(), fraseFactual].filter(Boolean).join(' ');

	return {
		bioCompleta,
		fraseFactual,
		totalPublicados: resumo?.totalPublicados ?? 0,
		anoInicial: resumo?.anoInicial,
		anoFinal: resumo?.anoFinal,
	};
}
