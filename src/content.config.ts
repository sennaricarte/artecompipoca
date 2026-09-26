import { defineCollection, reference } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

/** Conteúdo de arquivo (Wayback) não pode ter pubDate anterior ao acervo. */
const PUBDATE_ARQUIVO_MIN = new Date('2000-01-01T00:00:00.000Z');

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
				legacyUrl: z.string().optional(),
				origem: z.enum(['original', 'arquivo']).default('original'),
				draft: z.boolean().default(false),
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
				autor: reference('autores'),
				cover: image().optional(),
				coverAlt: z.string().optional(),
				legacyUrl: z.string().optional(),
				origem: z.enum(['original', 'arquivo']).default('original'),
				draft: z.boolean().default(false),
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
