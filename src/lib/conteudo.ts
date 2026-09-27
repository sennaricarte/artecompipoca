import { getCollection, type CollectionEntry } from 'astro:content';

export type EditoriaId = CollectionEntry<'artigos'>['data']['editoria'];
export type TipoResenha = CollectionEntry<'resenhas'>['data']['tipo'];

export const POSTS_POR_PAGINA = 12;

const NOMES_EDITORIA: Record<EditoriaId, string> = {
	cinema: 'Cinema',
	series: 'Séries',
	quadrinhos: 'HQ - Quadrinhos',
	musica: 'Música',
};

/** Rótulo do site ao listar as quatro editorias (menu, footer, OG padrão, home). */
export function rotuloEditoriasSite(): string {
	return `${NOMES_EDITORIA.cinema}, ${NOMES_EDITORIA.series}, ${NOMES_EDITORIA.quadrinhos} e ${NOMES_EDITORIA.musica}`;
}

/** Links das editorias no menu e hubs de busca. */
export const NAV_EDITORIAS: { id: EditoriaId; href: string; label: string }[] = [
	{ id: 'cinema', href: '/cinema/', label: NOMES_EDITORIA.cinema },
	{ id: 'series', href: '/series/', label: NOMES_EDITORIA.series },
	{ id: 'quadrinhos', href: '/quadrinhos/', label: NOMES_EDITORIA.quadrinhos },
	{ id: 'musica', href: '/musica/', label: NOMES_EDITORIA.musica },
];

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

/** Mapeia tipo de resenha → hub de editoria. */
export const TIPO_RESENHA_PARA_EDITORIA: Record<TipoResenha, EditoriaId> = {
	filme: 'cinema',
	serie: 'series',
	hq: 'quadrinhos',
	album: 'musica',
};

export type PostPorEditoria =
	| { kind: 'artigo'; entry: CollectionEntry<'artigos'> }
	| { kind: 'resenha'; entry: CollectionEntry<'resenhas'> };

/**
 * Artigos da editoria + resenhas do tipo correspondente, por pubDate desc.
 */
export async function getPorEditoria(
	editoria: EditoriaId,
): Promise<PostPorEditoria[]> {
	const [artigos, resenhas] = await Promise.all([getArtigos(), getResenhas()]);

	const artigosEd: PostPorEditoria[] = artigos
		.filter((a) => a.data.editoria === editoria)
		.map((entry) => ({ kind: 'artigo', entry }));

	const resenhasEd: PostPorEditoria[] = resenhas
		.filter((r) => TIPO_RESENHA_PARA_EDITORIA[r.data.tipo] === editoria)
		.map((entry) => ({ kind: 'resenha', entry }));

	return [...artigosEd, ...resenhasEd].sort(
		(a, b) => b.entry.data.pubDate.valueOf() - a.entry.data.pubDate.valueOf(),
	);
}

export function chavePost(item: PostPorEditoria): string {
	return item.kind === 'artigo'
		? `artigos/${item.entry.id}`
		: `resenhas/${item.entry.id}`;
}

export function hrefPost(item: PostPorEditoria): string {
	return item.kind === 'artigo'
		? `/${item.entry.data.editoria}/${item.entry.id}/`
		: `/resenhas/${item.entry.id}/`;
}

/** Rótulo decorativo da capa tipográfica (artigos). */
export function rotuloCapaArtigo(editoria: EditoriaId): string {
	return nomeEditoria(editoria);
}

type DadosResenha = CollectionEntry<'resenhas'>['data'];

/** Ano da obra: `anoObra` e, na falta, `ficha.ano`. */
export function anoDaObra(
	data: Pick<DadosResenha, 'anoObra' | 'ficha'>,
): number | undefined {
	return data.anoObra ?? data.ficha?.ano;
}

/** Rótulo decorativo da capa (cards, capa tipográfica e OG), ex.: "Crítica · Filme · 1974". */
export function rotuloCapaResenha(
	data: Pick<DadosResenha, 'tipo' | 'anoObra' | 'ficha'>,
): string {
	const partes = ['Crítica', nomeTipoResenha(data.tipo)];
	const ano = anoDaObra(data);
	if (ano != null) partes.push(String(ano));
	return partes.join(' · ');
}

export function editoriaDePost(item: PostPorEditoria): EditoriaId {
	return item.kind === 'artigo'
		? item.entry.data.editoria
		: TIPO_RESENHA_PARA_EDITORIA[item.entry.data.tipo];
}

export function totalPaginas(totalItens: number): number {
	if (totalItens <= 0) return 1;
	return Math.ceil(totalItens / POSTS_POR_PAGINA);
}

export function fatiaPagina<T>(itens: T[], pagina: number): T[] {
	const inicio = (pagina - 1) * POSTS_POR_PAGINA;
	return itens.slice(inicio, inicio + POSTS_POR_PAGINA);
}

/** Campos de imagem compartilhados entre cards e listagens. */
export function imagensPost(data: {
	cover?: CollectionEntry<'resenhas'>['data']['cover'];
	coverAlt?: string;
	coverCredito?: string;
	coverLicencaUrl?: string;
	coverPosicao?: string;
	cartaz?: CollectionEntry<'resenhas'>['data']['cartaz'];
	cartazAlt?: string;
	cartazCredito?: string;
}) {
	return {
		cover: data.cover,
		coverAlt: data.coverAlt,
		coverCredito: data.coverCredito,
		coverLicencaUrl: data.coverLicencaUrl,
		coverPosicao: data.coverPosicao,
		cartaz: data.cartaz,
		cartazAlt: data.cartazAlt,
		cartazCredito: data.cartazCredito,
	};
}
