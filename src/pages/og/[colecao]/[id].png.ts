import type { APIRoute, GetStaticPaths } from 'astro';
import {
	getArtigos,
	getResenhas,
	nomeEditoria,
	rotuloCapaResenha,
	TIPO_RESENHA_PARA_EDITORIA,
} from '../../../lib/conteudo';
import { caminhoCover, gerarOgPost, type DadosOgPost } from '../../../lib/og';

type Props = { dados: Omit<DadosOgPost, 'coverPath'>; filePath?: string };

export const getStaticPaths = (async () => {
	const [artigos, resenhas] = await Promise.all([getArtigos(), getResenhas()]);
	return [
		...artigos.map((entry) => ({
			params: { colecao: 'artigos', id: entry.id },
			props: {
				filePath: entry.filePath,
				dados: {
					titulo: entry.data.title,
					rotulo: nomeEditoria(entry.data.editoria),
					editoria: entry.data.editoria,
					idPost: entry.id,
				},
			} satisfies Props,
		})),
		...resenhas.map((entry) => ({
			params: { colecao: 'resenhas', id: entry.id },
			props: {
				filePath: entry.filePath,
				dados: {
					titulo: entry.data.title,
					rotulo: rotuloCapaResenha(entry.data),
					editoria: TIPO_RESENHA_PARA_EDITORIA[entry.data.tipo],
					idPost: entry.id,
					nota: entry.data.nota,
				},
			} satisfies Props,
		})),
	];
}) satisfies GetStaticPaths;

export const GET: APIRoute<Props> = async ({ props }) => {
	const coverPath = await caminhoCover(props.filePath);
	const png = await gerarOgPost({ ...props.dados, coverPath });
	return new Response(new Uint8Array(png), {
		headers: { 'Content-Type': 'image/png' },
	});
};
