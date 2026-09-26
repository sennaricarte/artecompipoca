import { defineCollection, reference } from 'astro:content';
import { glob, file } from 'astro/loaders';
import { z } from 'astro/zod';

const artigos = defineCollection({
	loader: glob({ base: './src/content/artigos', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z
			.object({
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
			})
			.refine((data) => !data.cover || Boolean(data.coverAlt), {
				message: 'coverAlt é obrigatório quando cover estiver definido',
				path: ['coverAlt'],
			}),
});

const resenhas = defineCollection({
	loader: glob({ base: './src/content/resenhas', pattern: '**/*.{md,mdx}' }),
	schema: ({ image }) =>
		z
			.object({
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
			})
			.refine((data) => !data.cover || Boolean(data.coverAlt), {
				message: 'coverAlt é obrigatório quando cover estiver definido',
				path: ['coverAlt'],
			}),
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
