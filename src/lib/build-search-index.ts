import {
	getArtigos,
	getResenhas,
	nomeEditoria,
	nomeTipoResenha,
} from './conteudo';
import type { SearchItem } from '../scripts/site-search';

export async function buildSearchIndex(): Promise<SearchItem[]> {
	const [artigos, resenhas] = await Promise.all([getArtigos(), getResenhas()]);

	const artigosIndex: SearchItem[] = artigos.map((entry) => ({
		type: 'artigo',
		title: entry.data.title,
		description: entry.data.description,
		category: nomeEditoria(entry.data.editoria),
		url: `/${entry.data.editoria}/${entry.id}/`,
		pubDate: entry.data.pubDate.toISOString(),
	}));

	const resenhasIndex: SearchItem[] = resenhas.map((entry) => ({
		type: 'resenha',
		title: entry.data.title,
		description: entry.data.description,
		category: nomeTipoResenha(entry.data.tipo),
		obra: entry.data.obra,
		url: `/resenhas/${entry.id}/`,
		pubDate: entry.data.pubDate.toISOString(),
	}));

	return [...resenhasIndex, ...artigosIndex];
}
