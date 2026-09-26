import { getCollection, type CollectionEntry } from 'astro:content';

export type EditoriaId = CollectionEntry<'artigos'>['data']['editoria'];
export type TipoResenha = CollectionEntry<'resenhas'>['data']['tipo'];

export const POSTS_POR_PAGINA = 12;

const NOMES_EDITORIA: Record<EditoriaId, string> = {
	cinema: 'Cinema',
	series: 'Séries',
	quadrinhos: 'Quadrinhos',
	musica: 'Música',
};

const NOMES_TIPO_RESENHA: Record<TipoResenha, string> = {
	filme: 'Filme',
	serie: 'Série',
	hq: 'HQ',
	album: 'Álbum',
};

export function mostrarRascunhos(): boolean {
	return import.meta.env.DEV || import.meta.env.PUBLIC_PREVIEW === 'true';
}

export async function getArtigos(): Promise<CollectionEntry<'artigos'>[]> {
	const all = await getCollection('artigos');
	const filtrados = mostrarRascunhos()
		? all
		: all.filter((entry) => !entry.data.draft);
	return filtrados.sort(
		(a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
	);
}

export async function getResenhas(): Promise<CollectionEntry<'resenhas'>[]> {
	const all = await getCollection('resenhas');
	const filtrados = mostrarRascunhos()
		? all
		: all.filter((entry) => !entry.data.draft);
	return filtrados.sort(
		(a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
	);
}

export function formatarData(date: Date): string {
	return new Intl.DateTimeFormat('pt-BR', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	}).format(date);
}

export function tempoLeitura(texto: string): number {
	const palavras = texto
		.trim()
		.split(/\s+/)
		.filter(Boolean).length;
	return Math.max(1, Math.ceil(palavras / 200));
}

export function nomeEditoria(editoria: EditoriaId): string {
	return NOMES_EDITORIA[editoria];
}

export function nomeTipoResenha(tipo: TipoResenha): string {
	return NOMES_TIPO_RESENHA[tipo];
}

export function totalPaginas(totalItens: number): number {
	if (totalItens <= 0) return 1;
	return Math.ceil(totalItens / POSTS_POR_PAGINA);
}

export function fatiaPagina<T>(itens: T[], pagina: number): T[] {
	const inicio = (pagina - 1) * POSTS_POR_PAGINA;
	return itens.slice(inicio, inicio + POSTS_POR_PAGINA);
}
