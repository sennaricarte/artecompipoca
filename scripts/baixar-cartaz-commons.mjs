#!/usr/bin/env node
/**
 * Baixa um cartaz em domínio público do Wikimedia Commons e o liga a uma resenha.
 *
 * Uso:
 *   pnpm cartaz:commons "<arquivo no Commons>" <resenha.md> [--alt "texto"] [--apply]
 *
 * Sem --apply: só consulta e mostra o que faria.
 * Com --apply: baixa para src/assets/capas/{id}.jpg (sem sobrescrever) e grava
 * cover, coverAlt e coverCredito no frontmatter (substituindo se já existirem).
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const RESENHAS_DIR = join(ROOT, 'src', 'content', 'resenhas');
const CAPAS_DIR = join(ROOT, 'src', 'assets', 'capas');
const USER_AGENT =
	'ArteComPipocaBot/1.0 (https://artecompipoca.net; contato@artecompipoca.net)';
const API = 'https://commons.wikimedia.org/w/api.php';

function parseArgs(argv) {
	const posicionais = [];
	let apply = false;
	let alt;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--apply') apply = true;
		else if (arg === '--alt') alt = argv[++i];
		else posicionais.push(arg);
	}
	return { arquivo: posicionais[0], resenha: posicionais[1], apply, alt };
}

function resolverResenha(arg) {
	const candidato = resolve(ROOT, arg);
	if (candidato.endsWith('.md') && dirname(candidato) !== ROOT) return candidato;
	return join(RESENHAS_DIR, basename(arg));
}

async function existe(caminho) {
	try {
		await access(caminho);
		return true;
	} catch {
		return false;
	}
}

function ehDominioPublico(licenca) {
	return /public\s*domain|dom[ií]nio\s*p[uú]blico|^PD([-\s]|$)/i.test(licenca);
}

function yamlString(valor) {
	return JSON.stringify(valor);
}

function separarFrontmatter(conteudo) {
	const m = conteudo.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!m) throw new Error('frontmatter não encontrado');
	return { yaml: m[1], resto: conteudo.slice(m[0].length), eol: m[2] || '\n' };
}

function lerCampo(yaml, chave) {
	const m = yaml.match(new RegExp(`^${chave}:\\s*(.+)$`, 'm'));
	return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
}

/** Ano da obra: ficha.ano, depois anoObra. */
function lerAno(yaml) {
	const ficha = yaml.match(/^ficha:\r?\n((?:[ \t]+.*\r?\n?)*)/m);
	const anoFicha = ficha?.[1].match(/^[ \t]+ano:\s*(\d{4})/m)?.[1];
	return anoFicha ?? lerCampo(yaml, 'anoObra');
}

function definirCampos(yaml, campos) {
	let linhas = yaml.split(/\r?\n/);
	const chaves = Object.keys(campos);
	linhas = linhas.filter(
		(l) => !chaves.some((c) => l.startsWith(`${c}:`)),
	);
	const idxTipo = linhas.findIndex((l) => l.startsWith('tipo:'));
	const novas = chaves.map((c) => `${c}: ${yamlString(campos[c])}`);
	const pos = idxTipo >= 0 ? idxTipo + 1 : linhas.length;
	linhas.splice(pos, 0, ...novas);
	return linhas.join('\n');
}

async function consultarCommons(arquivo) {
	const params = new URLSearchParams({
		action: 'query',
		titles: `File:${arquivo}`,
		prop: 'imageinfo',
		iiprop: 'url|size|extmetadata',
		format: 'json',
	});
	const res = await fetch(`${API}?${params}`, {
		headers: { 'User-Agent': USER_AGENT },
	});
	if (!res.ok) throw new Error(`API do Commons respondeu ${res.status}`);
	const json = await res.json();
	const pagina = Object.values(json.query?.pages ?? {})[0];
	const info = pagina?.imageinfo?.[0];
	if (!pagina || pagina.missing !== undefined || !info) {
		throw new Error(`arquivo não encontrado no Commons: File:${arquivo}`);
	}
	return info;
}

async function main() {
	const { arquivo, resenha, apply, alt } = parseArgs(process.argv.slice(2));
	if (!arquivo || !resenha) {
		console.error(
			'Uso: pnpm cartaz:commons "<arquivo no Commons>" <resenha.md> [--alt "texto"] [--apply]',
		);
		process.exitCode = 1;
		return;
	}

	const resenhaPath = resolverResenha(resenha);
	if (!(await existe(resenhaPath))) {
		throw new Error(`resenha não encontrada: ${relative(ROOT, resenhaPath)}`);
	}
	const id = basename(resenhaPath, extname(resenhaPath));

	const info = await consultarCommons(arquivo);
	const licenca = info.extmetadata?.LicenseShortName?.value ?? '(sem licença)';
	console.log(`Commons: File:${arquivo}`);
	console.log(`  URL:      ${info.url}`);
	console.log(`  Tamanho:  ${info.width}×${info.height}, ${info.size} bytes`);
	console.log(`  Licença:  ${licenca}`);

	if (!ehDominioPublico(licenca)) {
		console.error(
			`Abortado: a licença "${licenca}" não indica domínio público. Nada foi baixado.`,
		);
		process.exitCode = 1;
		return;
	}

	const extOriginal = extname(new URL(info.url).pathname).toLowerCase();
	if (extOriginal !== '.jpg' && extOriginal !== '.jpeg') {
		console.error(
			`Abortado: o original é "${extOriginal}", não JPEG. Nada foi baixado.`,
		);
		process.exitCode = 1;
		return;
	}

	const destino = join(CAPAS_DIR, `${id}.jpg`);
	const conteudo = await readFile(resenhaPath, 'utf8');
	const { yaml, resto } = separarFrontmatter(conteudo);
	const titulo = lerCampo(yaml, 'title') ?? id;
	const ano = lerAno(yaml);
	if (!ano) {
		throw new Error('ano da obra não encontrado (ficha.ano ou anoObra)');
	}

	const coverRel = relative(dirname(resenhaPath), destino).replace(/\\/g, '/');
	const campos = {
		cover: coverRel.startsWith('.') ? coverRel : `./${coverRel}`,
		coverAlt: alt ?? lerCampo(yaml, 'coverAlt') ?? `Cartaz original de ${titulo}`,
		coverCredito: `Cartaz original (${ano}), domínio público. Fonte: Wikimedia Commons`,
	};

	console.log(`\nResenha: ${relative(ROOT, resenhaPath)}`);
	console.log(`  Destino:      ${relative(ROOT, destino)}`);
	for (const [k, v] of Object.entries(campos)) console.log(`  ${k}: ${v}`);

	if (!apply) {
		console.log('\nModo leitura: nada foi alterado. Use --apply para gravar.');
		return;
	}

	if (await existe(destino)) {
		console.log(`\nImagem já existe, mantida: ${relative(ROOT, destino)}`);
	} else {
		const res = await fetch(info.url, { headers: { 'User-Agent': USER_AGENT } });
		if (!res.ok) throw new Error(`download respondeu ${res.status}`);
		await mkdir(CAPAS_DIR, { recursive: true });
		await writeFile(destino, Buffer.from(await res.arrayBuffer()), { flag: 'wx' });
		console.log(`\nBaixado: ${relative(ROOT, destino)}`);
	}

	const eol = conteudo.includes('\r\n') ? '\r\n' : '\n';
	const novoYaml = definirCampos(yaml, campos).replace(/\n/g, eol);
	await writeFile(resenhaPath, `---${eol}${novoYaml}${eol}---${eol}${resto}`);
	console.log(`Frontmatter atualizado: ${relative(ROOT, resenhaPath)}`);
}

main().catch((err) => {
	console.error('baixar-cartaz-commons falhou:', err.message ?? err);
	process.exitCode = 1;
});
