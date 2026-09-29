import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { splitFrontmatter, getScalar } from './lib/frontmatter.mjs';
import { RAIZ } from './lib/capas.mjs';

const COLECOES = [
	{ nome: 'artigos', dir: join(RAIZ, 'src', 'content', 'artigos') },
	{ nome: 'resenhas', dir: join(RAIZ, 'src', 'content', 'resenhas') },
];

async function listarArquivosMarkdown(dir) {
	const saida = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const caminho = join(dir, entry.name);
		if (entry.isDirectory()) {
			saida.push(...(await listarArquivosMarkdown(caminho)));
			continue;
		}
		if (entry.isFile() && ['.md', '.mdx'].includes(extname(entry.name))) {
			saida.push(caminho);
		}
	}
	return saida;
}

function toDate(value) {
	const date = new Date(value);
	return Number.isNaN(date.valueOf()) ? new Date(0) : date;
}

function formatarDia(date) {
	return date.toISOString().slice(0, 10);
}

function compararRecente(a, b) {
	return b.pubDate.valueOf() - a.pubDate.valueOf();
}

async function larguraCover(caminhoMarkdown, valorCover) {
	const caminhoImagem = resolve(dirname(caminhoMarkdown), valorCover);
	const meta = await sharp(caminhoImagem).metadata();
	const girada = (meta.orientation ?? 1) >= 5;
	return girada ? (meta.height ?? 0) : (meta.width ?? 0);
}

const grupos = {
	semCover: [],
	menor1200: [],
	com1200: [],
};

for (const colecao of COLECOES) {
	const arquivos = await listarArquivosMarkdown(colecao.dir);
	for (const caminho of arquivos) {
		const raw = await readFile(caminho, 'utf8');
		const parts = splitFrontmatter(raw);
		if (!parts) continue;

		const draft = getScalar(parts.fm, 'draft').toLowerCase() === 'true';
		if (draft) continue;

		const titulo = getScalar(parts.fm, 'title') || relative(colecao.dir, caminho);
		const cover = getScalar(parts.fm, 'cover');
		const pubDate = toDate(getScalar(parts.fm, 'pubDate'));
		const id = relative(colecao.dir, caminho).replace(/\.(md|mdx)$/i, '').replaceAll('\\', '/');
		const itemBase = {
			titulo,
			pubDate,
			ref: `${colecao.nome}/${id}`,
		};

		if (!cover) {
			grupos.semCover.push(itemBase);
			continue;
		}

		const largura = await larguraCover(caminho, cover);
		if (largura < 1200) {
			grupos.menor1200.push({ ...itemBase, largura });
			continue;
		}

		grupos.com1200.push({ ...itemBase, largura });
	}
}

grupos.semCover.sort(compararRecente);
grupos.menor1200.sort(compararRecente);
grupos.com1200.sort(compararRecente);

console.log(`Sem cover (${grupos.semCover.length})`);
for (const item of grupos.semCover) {
	console.log(`- ${formatarDia(item.pubDate)} | ${item.ref} | ${item.titulo}`);
}

console.log(`\nCover menor que 1200px (${grupos.menor1200.length})`);
for (const item of grupos.menor1200) {
	console.log(`- ${formatarDia(item.pubDate)} | ${item.ref} | ${item.largura}px | ${item.titulo}`);
}

console.log(`\nCover com 1200px ou mais (${grupos.com1200.length})`);
for (const item of grupos.com1200) {
	console.log(`- ${formatarDia(item.pubDate)} | ${item.ref} | ${item.largura}px | ${item.titulo}`);
}

console.log(
	`\nResumo: sem cover ${grupos.semCover.length}; menor que 1200px ${grupos.menor1200.length}; com 1200px ou mais ${grupos.com1200.length}.`,
);
