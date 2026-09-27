import { defineCollection, reference } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

/** Conteúdo de arquivo (Wayback) não pode ter pubDate anterior ao acervo. */
const PUBDATE_ARQUIVO_MIN = new Date('2000-01-01T00:00:00.000Z');

const PUBLICACAO_HQ = z.enum([
	'Série regular',
	'Minissérie',
	'Graphic novel',
	'One-shot',
	'Tira',
]);

const STATUS_HQ = z.enum([
	'Em andamento',
	'Terminada',
	'Cancelada',
	'Cancelada/Terminada',
]);

const obraLista = z.object({
	titulo: z.string(),
	tipo: z.enum(['filme', 'serie']),
	wikidataId: z
		.string()
		.regex(/^Q\d+$/, 'wikidataId deve ser Q seguido de dígitos'),
	tituloOriginal: z.string().optional(),
	ano: z.number().optional(),
	anoFim: z.number().optional(),
	direcao: z.array(z.string()).optional(),
	criacao: z.array(z.string()).optional(),
	temporadas: z.number().optional(),
});

/**
 * @template {z.ZodRawShape} T
 * @param {z.ZodObject<T>} schema
 */
function withArquivoPubDateGuard(schema) {
	return schema
		.refine((data) => !data.cover || Boolean(data.coverAlt), {
			message: 'coverAlt é obrigatório quando cover estiver definido',
			path: ['coverAlt'],
		})
		.refine((data) => !data.cartaz || Boolean(data.cartazAlt), {
			message: 'cartazAlt é obrigatório quando cartaz estiver definido',
			path: ['cartazAlt'],
		})
		.refine(
			(data) =>
				data.origem !== 'arquivo' ||
				data.pubDate.getTime() >= PUBDATE_ARQUIVO_MIN.getTime(),
			{
				message:
					'pubDate de conteúdo com origem "arquivo" deve ser >= 2000-01-01',
				path: ['pubDate'],
			},
		);
}

const artigos = defineCollection({
	loader: glob({ base: './src/content/artigos', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		withArquivoPubDateGuard(
			z.object({
				title: z.string(),
				seoTitle: z.string().optional(),
				description: z.string(),
				editoria: z.enum(['cinema', 'series', 'quadrinhos', 'musica']),
				pubDate: z.coerce.date(),
				updatedDate: z.coerce.date().optional(),
				autor: reference('autores'),
				cover: image().optional(),
				coverAlt: z.string().optional(),
				coverCredito: z.string().optional(),
				coverLicencaUrl: z.string().url().optional(),
				/** object-position da cena na moldura 16:9 (ex.: "center 30%"). */
				coverPosicao: z.string().optional(),
				cartaz: image().optional(),
				cartazAlt: z.string().optional(),
				cartazCredito: z.string().optional(),
				legacyUrl: z.string().optional(),
				origem: z.enum(['original', 'arquivo']).default('original'),
				draft: z.boolean().default(false),
				notaEditorial: z.string().optional(),
				obras: z.array(obraLista).optional(),
			}),
		),
});

const resenhas = defineCollection({
	loader: glob({ base: './src/content/resenhas', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		withArquivoPubDateGuard(
			z.object({
				title: z.string(),
				seoTitle: z.string().optional(),
				description: z.string(),
				obra: z.string(),
				tipo: z.enum(['filme', 'serie', 'hq', 'album']),
				anoObra: z.number().optional(),
				nota: z.number().min(0).max(10).optional(),
				pubDate: z.coerce.date(),
				updatedDate: z.coerce.date().optional(),
				autor: reference('autores'),
				cover: image().optional(),
				coverAlt: z.string().optional(),
				coverCredito: z.string().optional(),
				coverLicencaUrl: z.string().url().optional(),
				/** object-position da cena na moldura 16:9 (ex.: "center 30%"). */
				coverPosicao: z.string().optional(),
				cartaz: image().optional(),
				cartazAlt: z.string().optional(),
				cartazCredito: z.string().optional(),
				legacyUrl: z.string().optional(),
				origem: z.enum(['original', 'arquivo']).default('original'),
				draft: z.boolean().default(false),
				notaEditorial: z.string().optional(),
				ficha: z
					.object({
						tituloOriginal: z.string().optional(),
						ano: z.number().optional(),
						direcao: z.array(z.string()).optional(),
						roteiro: z.array(z.string()).optional(),
						elenco: z.array(z.string()).max(6).optional(),
						generos: z.array(z.string()).optional(),
						duracaoMin: z.number().optional(),
						paises: z.array(z.string()).optional(),
						criadores: z.array(z.string()).optional(),
						temporadas: z.number().optional(),
						emissora: z.string().optional(),
						wikidataId: z
							.string()
							.regex(/^Q\d+$/, 'wikidataId deve ser Q seguido de dígitos')
							.optional(),
						sinopse: z.string().optional(),
						editora: z.string().optional(),
						editoraBrasil: z.string().optional(),
						publicacao: PUBLICACAO_HQ.optional(),
						status: STATUS_HQ.optional(),
						edicoes: z.number().optional(),
						paginas: z.number().optional(),
						arte: z.array(z.string()).optional(),
						curiosidades: z.array(z.string()).optional(),
						premios: z.array(z.string()).optional(),
						trailerYoutubeId: z
							.string()
							.regex(
								/^[A-Za-z0-9_-]{11}$/,
								'trailerYoutubeId deve ter 11 caracteres [A-Za-z0-9_-]',
							)
							.optional(),
						fontes: z
							.array(
								z.object({
									nome: z.string(),
									url: z.string().url(),
								}),
							)
							.optional(),
					})
					.optional(),
			}),
		),
});

const autores = defineCollection({
	loader: file('src/data/autores.json'),
	schema: z.object({
		id: z.string(),
		nome: z.string(),
		bio: z.string(),
		avatar: z.string().optional(),
	}),
});

const editorias = defineCollection({
	loader: file('src/data/editorias.json'),
	schema: z.object({
		id: z.string(),
		nome: z.string(),
		descricao: z.string(),
	}),
});

export const collections = { artigos, resenhas, autores, editorias };
