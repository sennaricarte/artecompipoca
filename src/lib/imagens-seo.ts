import { getImage, type ImageMetadata } from 'astro:assets';

const DISCOVER_VARIANTES = [
	{ width: 1200, height: 675 },
	{ width: 1200, height: 900 },
	{ width: 1200, height: 1200 },
] as const;

type CoverOptions = {
	cover?: ImageMetadata;
	coverPosicao?: string;
	site: URL;
};

type StructuredDataImageOptions = CoverOptions & {
	fallbackOgImage: string;
};

function absoluto(src: string, site: URL): string {
	return new URL(src, site).href;
}

function normalizarTokenPosicao(
	token: string,
	eixo: 'x' | 'y',
): 'left' | 'center' | 'right' | 'top' | 'bottom' {
	const valor = Number.parseFloat(token);
	if (Number.isNaN(valor)) return 'center';
	if (valor <= 33) return eixo === 'x' ? 'left' : 'top';
	if (valor >= 67) return eixo === 'x' ? 'right' : 'bottom';
	return 'center';
}

function normalizarCoverPosicao(coverPosicao?: string): string {
	if (!coverPosicao?.trim()) return 'center';
	const partes = coverPosicao.trim().split(/\s+/);
	if (!partes.some((parte) => parte.endsWith('%'))) return coverPosicao;

	const [x = 'center', y = 'center'] = partes;
	const xNormalizado = x.endsWith('%') ? normalizarTokenPosicao(x, 'x') : x;
	const yNormalizado = y.endsWith('%') ? normalizarTokenPosicao(y, 'y') : y;

	if (yNormalizado === 'top' || yNormalizado === 'bottom') return yNormalizado;
	if (xNormalizado === 'left' || xNormalizado === 'right') return xNormalizado;
	return 'center';
}

async function gerarJpegCover({
	cover,
	coverPosicao,
	site,
	width,
	height,
}: CoverOptions & { width: number; height: number }) {
	if (!cover) return null;

	const imagem = await getImage({
		src: cover,
		width,
		height,
		format: 'jpeg',
		quality: 82,
		fit: 'cover',
		position: normalizarCoverPosicao(coverPosicao),
	});

	return {
		url: absoluto(imagem.src, site),
		width,
		height,
	};
}

export function coverQualificaDiscover(cover?: ImageMetadata): cover is ImageMetadata {
	return Boolean(cover && cover.width >= 1200);
}

export async function getStructuredDataImages({
	cover,
	coverPosicao,
	fallbackOgImage,
	site,
}: StructuredDataImageOptions): Promise<string | string[]> {
	if (!coverQualificaDiscover(cover)) {
		return absoluto(fallbackOgImage, site);
	}

	const imagens = await Promise.all(
		DISCOVER_VARIANTES.map((variant) =>
			gerarJpegCover({
				cover,
				coverPosicao,
				site,
				width: variant.width,
				height: variant.height,
			}),
		),
	);

	return imagens
		.filter((image): image is NonNullable<typeof image> => Boolean(image))
		.map((image) => image.url);
}

export async function getRssCoverEnclosure({
	cover,
	coverPosicao,
	site,
}: CoverOptions): Promise<{ url: string; type: string; length: number } | undefined> {
	if (!cover) return undefined;

	const imagem = await gerarJpegCover({
		cover,
		coverPosicao,
		site,
		width: 1200,
		height: 675,
	});

	if (!imagem) return undefined;

	return {
		url: imagem.url,
		type: 'image/jpeg',
		length: 0,
	};
}
