import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import sharp from 'sharp';
import { capaDoPost, COR_FUNDO_SITE, COR_PIPOCA, temaEditoria, type TemaCapa } from './capas';
import { rotuloEditoriasSite, type EditoriaId } from './conteudo';

export const OG_LARGURA = 1200;
export const OG_ALTURA = 630;

const DIR_FONTES = join(process.cwd(), 'src', 'assets', 'og-fontes');

type No = { type: string; props: Record<string, unknown> };

function el(
	type: string,
	style: Record<string, unknown>,
	children?: unknown,
	extra: Record<string, unknown> = {},
): No {
	return { type, props: { style, children, ...extra } };
}

let fontesCache: Promise<Parameters<typeof satori>[1]['fonts']> | undefined;

function carregarFontes() {
	fontesCache ??= Promise.all([
		readFile(join(DIR_FONTES, 'BebasNeue-Regular.ttf')),
		readFile(join(DIR_FONTES, 'Inter-Regular.ttf')),
		readFile(join(DIR_FONTES, 'Inter-Bold.ttf')),
	]).then(([bebas, inter, interBold]) => [
		{ name: 'Bebas Neue', data: bebas, weight: 400, style: 'normal' },
		{ name: 'Inter', data: inter, weight: 400, style: 'normal' },
		{ name: 'Inter', data: interBold, weight: 700, style: 'normal' },
	]);
	return fontesCache;
}

async function renderizar(arvore: No): Promise<Buffer> {
	const svg = await satori(arvore as never, {
		width: OG_LARGURA,
		height: OG_ALTURA,
		fonts: await carregarFontes(),
	});
	const png = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_LARGURA },
	})
		.render()
		.asPng();
	return sharp(png).png({ compressionLevel: 9, palette: true, colors: 256, dither: 1 }).toBuffer();
}

function marca(tema: Pick<TemaCapa, 'texto' | 'claro'>, tamanho = 44): No {
	const texto = el(
		'div',
		{ display: 'flex', fontFamily: 'Bebas Neue', fontSize: tamanho, letterSpacing: 2 },
		[
			el('span', { color: tema.claro ? '#ffffff' : tema.texto }, 'ARTE COM\u00a0'),
			el('span', { color: COR_PIPOCA }, 'PIPOCA'),
		],
	);
	if (!tema.claro) return texto;
	return el(
		'div',
		{
			display: 'flex',
			alignSelf: 'flex-start',
			background: COR_FUNDO_SITE,
			padding: '6px 18px',
			borderRadius: 6,
		},
		[texto],
	);
}

function tamanhoTitulo(titulo: string, larguraColuna: number): number {
	const base = larguraColuna > 900 ? 1 : 0.78;
	const n = titulo.length;
	const px = n <= 18 ? 132 : n <= 32 ? 108 : n <= 50 ? 88 : 72;
	return Math.round(px * base);
}

export interface DadosOgPost {
	titulo: string;
	rotulo: string;
	editoria: EditoriaId;
	/** Id do post: mesma variante de cor da capa no site. */
	idPost: string;
	nota?: number;
	/** Caminho absoluto do arquivo original da cena (cover). */
	coverPath?: string;
}

async function prepararCena(caminho: string): Promise<string> {
	const buf = await sharp(caminho)
		.resize({ width: OG_LARGURA, height: OG_ALTURA, fit: 'cover' })
		.jpeg({ quality: 82 })
		.toBuffer();
	return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

function colunaTexto(
	dados: DadosOgPost,
	tema: Pick<TemaCapa, 'texto' | 'rotulo' | 'seloBg' | 'seloTexto' | 'claro'>,
	largura: number,
	padding: number,
): No {
	const larguraUtil = largura - padding * 2;
	const topo = el(
		'div',
		{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' },
		[
			el(
				'div',
				{
					display: 'flex',
					fontFamily: 'Inter',
					fontWeight: 700,
					fontSize: 26,
					letterSpacing: 4,
					textTransform: 'uppercase',
					color: tema.rotulo,
					marginTop: 8,
				},
				dados.rotulo,
			),
			dados.nota != null
				? el(
						'div',
						{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: 124,
							height: 124,
							borderRadius: 62,
							background: tema.seloBg,
							color: tema.seloTexto,
							fontFamily: 'Bebas Neue',
							fontSize: 44,
							flexShrink: 0,
						},
						`${dados.nota}/10`,
					)
				: el('div', { display: 'flex' }),
		],
	);

	const fontSize = tamanhoTitulo(dados.titulo, larguraUtil);
	const titulo = el(
		'div',
		{
			display: 'block',
			fontFamily: 'Bebas Neue',
			fontSize,
			lineHeight: 0.95,
			letterSpacing: 1,
			color: tema.texto,
			width: larguraUtil,
			lineClamp: 3,
		},
		dados.titulo,
	);

	return el(
		'div',
		{
			display: 'flex',
			flexDirection: 'column',
			justifyContent: 'space-between',
			width: largura,
			height: OG_ALTURA,
			padding,
		},
		[topo, titulo, marca(tema)],
	);
}

export async function gerarOgPost(dados: DadosOgPost): Promise<Buffer> {
	const tema = capaDoPost(dados.editoria, dados.idPost);
	const cena = dados.coverPath ? await prepararCena(dados.coverPath) : undefined;

	if (cena) {
		const temaEscuro = { ...tema, texto: '#ffffff', rotulo: '#f2f2f2', claro: false };
		return renderizar(
			el('div', { display: 'flex', position: 'relative', width: OG_LARGURA, height: OG_ALTURA, background: COR_FUNDO_SITE }, [
				el('img', { position: 'absolute', top: 0, left: 0, width: OG_LARGURA, height: OG_ALTURA }, undefined, {
					src: cena,
					width: OG_LARGURA,
					height: OG_ALTURA,
				}),
				el('div', {
					position: 'absolute',
					top: 0,
					left: 0,
					width: OG_LARGURA,
					height: OG_ALTURA,
					backgroundImage: 'linear-gradient(90deg, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.6) 100%)',
				}),
				colunaTexto(dados, temaEscuro, OG_LARGURA, 72),
			]),
		);
	}

	return renderizar(
		el('div', { display: 'flex', width: OG_LARGURA, height: OG_ALTURA, backgroundImage: tema.fundo }, [
			colunaTexto(dados, tema, OG_LARGURA, 72),
		]),
	);
}

export async function gerarOgPadrao(): Promise<Buffer> {
	const tema = temaEditoria('cinema');
	return renderizar(
		el(
			'div',
			{
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'center',
				width: OG_LARGURA,
				height: OG_ALTURA,
				padding: 80,
				backgroundImage: tema.fundo,
			},
			[
				marca(tema, 176),
				el(
					'div',
					{ display: 'flex', marginTop: 24, fontFamily: 'Inter', fontSize: 42, color: tema.rotulo },
					`${rotuloEditoriasSite()} desde 2013`,
				),
			],
		),
	);
}

/**
 * Resolve o caminho do arquivo de `cover` a partir do frontmatter bruto do post.
 * Fotos com licença CC (coverLicencaUrl) ficam fora do OG: a atribuição com link
 * não cabe na imagem, então esses posts usam o layout tipográfico.
 */
export async function caminhoCover(filePath: string | undefined): Promise<string | undefined> {
	if (!filePath) return undefined;
	const absoluto = resolve(process.cwd(), filePath);
	const bruto = await readFile(absoluto, 'utf8');
	const fm = bruto.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
	if (/^coverLicencaUrl:/m.test(fm)) return undefined;
	const valor = fm.match(/^cover:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
	return valor ? resolve(dirname(absoluto), valor) : undefined;
}
