/**
 * Lógica compartilhada de capas (cena → cover) e cartazes (cartaz) dos posts.
 * Usada por scripts/capa-adicionar.mjs e scripts/capas-lote.mjs.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';

export const RAIZ = process.cwd();
export const DIR_CAPAS = join(RAIZ, 'src', 'assets', 'capas');
const COLECOES = ['resenhas', 'artigos'];

export const LADO_MAIOR_MAX = 2000;
export const QUALIDADE_JPEG = 85;

/** Largura a partir da qual a cena se qualifica para imagem grande no Discover. */
export const CENA_LARGURA_IDEAL = 1200;
/** Cartaz quadrado (capa de disco): proporção aceita e lado mínimo. */
export const QUADRADO_PROPORCAO = [0.95, 1.05];
export const QUADRADO_LADO_MIN = 500;

/** Regras por tipo: orientação, dimensão mínima e campos do frontmatter. */
export const REGRAS = {
	cena: {
		orientacao: 'horizontal',
		minimo: { lado: 'largura', px: 1000 },
		campoImagem: 'cover',
		campoAlt: 'coverAlt',
		campoCredito: 'coverCredito',
	},
	cartaz: {
		orientacao: 'vertical',
		minimo: { lado: 'altura', px: 400 },
		campoImagem: 'cartaz',
		campoAlt: 'cartazAlt',
		campoCredito: 'cartazCredito',
	},
};

/** Ordem de inserção dos campos de imagem no frontmatter. */
const ORDEM_CAMPOS = [
	'cover',
	'coverAlt',
	'coverCredito',
	'coverLicencaUrl',
	'coverPosicao',
	'cartaz',
	'cartazAlt',
	'cartazCredito',
];

/**
 * @param {string} id
 * @returns {{ colecao: string, caminho: string }}
 */
export function localizarPost(id) {
	const achados = COLECOES.flatMap((colecao) =>
		['md', 'mdx']
			.map((ext) => join(RAIZ, 'src', 'content', colecao, `${id}.${ext}`))
			.filter((c) => existsSync(c))
			.map((caminho) => ({ colecao, caminho })),
	);
	if (achados.length === 0) throw new Error(`post "${id}" não encontrado em resenhas nem artigos`);
	if (achados.length > 1) throw new Error(`id "${id}" ambíguo: ${achados.map((a) => a.colecao).join(', ')}`);
	return achados[0];
}

/** @param {string} bruto */
function separarFrontmatter(bruto) {
	const m = bruto.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) throw new Error('frontmatter não encontrado');
	const eol = bruto.includes('\r\n') ? '\r\n' : '\n';
	return { fm: m[1], eol };
}

/**
 * @param {string} fm
 * @param {string} chave
 */
export function valorCampo(fm, chave) {
	const v = fm.match(new RegExp(`^${chave}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim();
	if (!v) return undefined;
	return v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
}

/**
 * Grava/remove campos de topo do frontmatter preservando o resto do arquivo.
 * @param {string} bruto
 * @param {Record<string, string>} definir
 * @param {string[]} remover
 */
export function editarFrontmatter(bruto, definir, remover) {
	const { fm, eol } = separarFrontmatter(bruto);
	let linhas = fm.split(/\r?\n/);
	const chaveDe = (l) => l.match(/^([A-Za-z][\w]*):/)?.[1];

	linhas = linhas.filter((l) => !remover.includes(chaveDe(l) ?? ''));

	for (const [chave, valor] of Object.entries(definir)) {
		const linha = `${chave}: ${JSON.stringify(valor)}`;
		const i = linhas.findIndex((l) => chaveDe(l) === chave);
		if (i >= 0) {
			linhas[i] = linha;
			continue;
		}
		// Insere depois do último campo de imagem que venha antes na ordem; senão depois de autor.
		const pos = ORDEM_CAMPOS.indexOf(chave);
		let alvo = -1;
		for (const anterior of ORDEM_CAMPOS.slice(0, pos).reverse()) {
			alvo = linhas.findIndex((l) => chaveDe(l) === anterior);
			if (alvo >= 0) break;
		}
		if (alvo < 0) alvo = linhas.findIndex((l) => chaveDe(l) === 'autor');
		if (alvo < 0) alvo = linhas.length - 1;
		linhas.splice(alvo + 1, 0, linha);
	}

	return bruto.replace(fm, linhas.join(eol));
}

/**
 * @param {{ width?: number, height?: number }} meta
 * @param {'cena' | 'cartaz'} tipo
 * @param {string} [tipoPost] tipo da resenha (filme, serie, hq, album)
 * @returns {string | null} motivo da reprovação ou null
 */
export function validarDimensoes(meta, tipo, tipoPost) {
	const w = meta.width ?? 0;
	const h = meta.height ?? 0;
	const regra = REGRAS[tipo];
	// Regras especiais para cartaz de álbum e série:
	// - álbum: deve ser quadrado (mesma regra antiga)
	// - série: pode ser quadrado OU vertical (proporção < 0.95) com altura mínima de 400px
	if (tipo === 'cartaz' && tipoPost === 'album') {
		const proporcao = h ? w / h : 0;
		const [min, max] = QUADRADO_PROPORCAO;
		if (proporcao < min || proporcao > max) {
			return `cartaz precisa ser quadrado (proporção ${proporcao.toFixed(2)}, aceito ${min}–${max})`;
		}
		if (Math.min(w, h) < QUADRADO_LADO_MIN) {
			return `lado mínimo de ${QUADRADO_LADO_MIN}px (tem ${Math.min(w, h)}px)`;
		}
		return null;
	}
	if (tipo === 'cartaz' && tipoPost === 'serie') {
		const proporcao = h ? w / h : 0;
		const [min, max] = QUADRADO_PROPORCAO;
		// caso quadrado
		if (proporcao >= min && proporcao <= max) {
			if (Math.min(w, h) < QUADRADO_LADO_MIN) {
				return `lado mínimo de ${QUADRADO_LADO_MIN}px (tem ${Math.min(w, h)}px)`;
			}
			return null;
		}
		// caso vertical aceitável (proporção < min)
		if (proporcao < min) {
			if (!(h > w)) {
				return `cartaz precisa ser vertical (${w}×${h})`;
			}
			if (h < 400) {
				return `altura mínima de 400px para cartaz vertical de série (tem ${h}px)`;
			}
			return null;
		}
		// demais casos (muito horizontal)
		return `cartaz precisa ser quadrado (proporção ${proporcao.toFixed(2)}, aceito ${min}–${max})`;
	}
	if (regra.orientacao === 'horizontal' && !(w > h)) {
		return `cena precisa ser horizontal (${w}×${h})`;
	}
	if (regra.orientacao === 'vertical' && !(h > w)) {
		return `cartaz precisa ser vertical (${w}×${h})`;
	}
	const medida = regra.minimo.lado === 'largura' ? w : h;
	if (medida < regra.minimo.px) {
		return `${regra.minimo.lado} mínima de ${regra.minimo.px}px (tem ${medida}px)`;
	}
	return null;
}

/**
 * Monta o plano de gravação sem tocar em nada.
 * @param {{
 *   id: string,
 *   origem: string,
 *   tipo: 'cena' | 'cartaz',
 *   credito: string,
 *   alt: string,
 *   posicao?: string,
 *   substituir?: boolean,
 * }} opcoes
 */
export async function planejarCapa(opcoes) {
	const { id, origem, tipo, credito, alt, posicao, substituir = false } = opcoes;
	const regra = REGRAS[tipo];
	if (!regra) throw new Error(`--tipo deve ser cena ou cartaz (recebido: ${tipo})`);

	const post = localizarPost(id);
	const bruto = await readFile(post.caminho, 'utf8');
	const { fm } = separarFrontmatter(bruto);

	const caminhoOrigem = resolve(RAIZ, origem);
	if (!existsSync(caminhoOrigem)) throw new Error(`imagem não encontrada: ${origem}`);
	const meta = await sharp(caminhoOrigem).metadata();
	// Com orientação EXIF 5–8 a imagem é exibida girada 90°.
	const girada = (meta.orientation ?? 1) >= 5;
	const dims = girada
		? { width: meta.height, height: meta.width }
		: { width: meta.width, height: meta.height };

	const destino = join(DIR_CAPAS, `${id}-${tipo}.jpg`);
	const valorImagem = relative(dirname(post.caminho), destino).replaceAll('\\', '/');

	const atual = valorCampo(fm, regra.campoImagem);
	const arquivoAtual = atual ? resolve(dirname(post.caminho), atual) : undefined;

	const tipoPost = valorCampo(fm, 'tipo');
	const problemas = [];
	const avisos = [];
	const motivo = validarDimensoes(dims, tipo, tipoPost);
	if (motivo) problemas.push(motivo);
	else if (tipo === 'cena' && (dims.width ?? 0) < CENA_LARGURA_IDEAL) {
		avisos.push(
			'Abaixo de 1200px: esta capa não se qualifica para imagem grande no Google Discover.',
		);
	}
	if (!alt?.trim()) problemas.push('alt vazio');
	if (!credito?.trim()) problemas.push('crédito vazio');
	if (!substituir) {
		if (atual) problemas.push(`post já tem ${regra.campoImagem} (use --substituir)`);
		else if (existsSync(destino)) problemas.push(`${relative(RAIZ, destino)} já existe (use --substituir)`);
	}

	const definir = {
		[regra.campoImagem]: valorImagem,
		[regra.campoAlt]: alt.trim(),
		[regra.campoCredito]: credito.trim(),
	};
	const remover = [];
	if (tipo === 'cena') {
		remover.push('coverLicencaUrl');
		if (posicao?.trim()) definir.coverPosicao = posicao.trim();
		else remover.push('coverPosicao');
	}

	return {
		id,
		colecao: post.colecao,
		caminhoPost: post.caminho,
		tipo,
		caminhoOrigem,
		largura: dims.width ?? 0,
		altura: dims.height ?? 0,
		destino,
		arquivoAntigo:
			arquivoAtual && arquivoAtual !== destino && existsSync(arquivoAtual) ? arquivoAtual : undefined,
		tinhaLicenca: tipo === 'cena' && Boolean(valorCampo(fm, 'coverLicencaUrl')),
		definir,
		remover,
		problemas,
		avisos,
	};
}

/**
 * Converte a imagem, grava o frontmatter e apaga o arquivo antigo.
 * @param {Awaited<ReturnType<typeof planejarCapa>>} plano
 */
export async function aplicarCapa(plano) {
	if (plano.problemas.length) throw new Error(`plano com problemas: ${plano.problemas.join('; ')}`);
	await mkdir(DIR_CAPAS, { recursive: true });
	const buf = await sharp(plano.caminhoOrigem)
		.rotate()
		.resize({
			width: LADO_MAIOR_MAX,
			height: LADO_MAIOR_MAX,
			fit: 'inside',
			withoutEnlargement: true,
		})
		.jpeg({ quality: QUALIDADE_JPEG, mozjpeg: true })
		.toBuffer();
	await writeFile(plano.destino, buf);

	const bruto = await readFile(plano.caminhoPost, 'utf8');
	await writeFile(plano.caminhoPost, editarFrontmatter(bruto, plano.definir, plano.remover), 'utf8');

	if (plano.arquivoAntigo) await unlink(plano.arquivoAntigo);
}
