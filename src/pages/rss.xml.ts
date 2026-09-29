import rss from '@astrojs/rss';
import { getEntry } from 'astro:content';
import {
	getPostsPublicadosOrdenados,
	hrefPost,
	nomeEditoria,
} from '../lib/conteudo';
import { getRssCoverEnclosure } from '../lib/imagens-seo';

export async function GET(context: { site?: URL }) {
	const site = context.site ?? new URL('https://artecompipoca.net');
	const posts = (await getPostsPublicadosOrdenados()).slice(0, 30);

	const items = await Promise.all(
		posts.map(async (post) => {
			const autorEntry = await getEntry(post.entry.data.autor);
			const enclosure = await getRssCoverEnclosure({
				cover: post.entry.data.cover,
				coverPosicao: post.entry.data.coverPosicao,
				site,
			});

			return {
				title: post.entry.data.title,
				description: post.entry.data.description,
				link: hrefPost(post),
				pubDate: post.entry.data.pubDate,
				author: autorEntry?.data.nome ?? 'Autor',
				categories: [
					post.kind === 'artigo'
						? nomeEditoria(post.entry.data.editoria)
						: 'Crítica',
				],
				enclosure,
			};
		}),
	);

	return rss({
		title: 'Arte Com Pipoca',
		description: 'Os 30 posts publicados mais recentes do Arte Com Pipoca.',
		site,
		items,
		trailingSlash: true,
	});
}
