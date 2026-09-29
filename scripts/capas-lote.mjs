/**
 * Aplica em lote cenas (cover) e cartazes a partir de _recuperados/imagens/.
 *
 * Uso: pnpm capas:lote [--apply]
 *
 * - Imagens: {id}-cena.{jpg,jpeg,png,webp} e {id}-cartaz.{...}; outros nomes são ignorados.
 * - Crédito: coluna credito_sugerido de _recuperados/distribuidoras-resenhas.csv
 *   (vazio ou ausente → "Divulgação", listado no resumo).
 * - Alt e posição: _recuperados/capas-lote.json ({ "{id}-{tipo}": { alt, posicao? } }).
 * - Mesmas validações do capa:adicionar; reprovadas ficam de fora sem interromper o lote.
 * - Substitui capas existentes e apaga o arquivo antigo; cena remove coverLicencaUrl.
 * Sem --apply só mostra a tabela.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aplicarCapa, planejarCapa, RAIZ } from './lib/capas.mjs';

const DIR_IMAGENS = join(RAIZ, '_recuperados', 'imagens');
const CSV_CREDITOS = join(RAIZ, '_recuperados', 'distribuidoras-resenhas.csv');
const JSON_ALTS = join(RAIZ, '_recuperados', 'capas-lote.json');
const CREDITO_PADRAO = 'Divulgação';
const ALT_MAX = 120;
const PADRAO_ARQUIVO = /^(.+)-(cena|cartaz)\.(jpe?g|png|webp)$/i;

const aplicar = process.argv.includes('--apply');

/** @param {string} texto */
function lerCsv(texto) {
	const linhas = texto.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
	const campos = (linha) => {
		const out = [];
		let atual = '';
		let aspas = false;
		for (let i = 0; i < linha.length; i++) {
			const c = linha[i];
			if (aspas) {
				if (c === '"' && linha[i + 1] === '"') { atual += '"'; i++; }
				else if (c === '"') aspas = false;
				else atual += c;
			} else if (c === '"') aspas = true;
			else if (c === ',') { out.push(atual); atual = ''; }
			else atual += c;
		}
		out.push(atual);
		return out;
	};
	const [cab, ...resto] = linhas.map(campos);
	return resto.map((vals) => Object.fromEntries(cab.map((k, i) => [k.trim(), (vals[i] ?? '').trim()])));
}

const creditos = new Map(
	existsSync(CSV_CREDITOS)
		? lerCsv(await readFile(CSV_CREDITOS, 'utf8')).map((l) => [l.arquivo, l.credito_sugerido])
		: [],
);
const alts = existsSync(JSON_ALTS) ? JSON.parse(await readFile(JSON_ALTS, 'utf8')) : {};

const arquivos = (await readdir(DIR_IMAGENS, { withFileTypes: true }))
	.filter((d) => d.isFile())
	.map((d) => d.name)
	.sort();

const linhas = [];
const ignorados = [];
const creditoPadrao = [];
const abaixoIdeal = [];

for (const nome of arquivos) {
	const m = nome.match(PADRAO_ARQUIVO);
	if (!m) {
		ignorados.push(nome);
		continue;
	}
	const [, id, tipoBruto] = m;
	const tipo = /** @type {'cena' | 'cartaz'} */ (tipoBruto.toLowerCase());
	const chave = `${id}-${tipo}`;
	const alt = alts[chave]?.alt ?? '';
	const posicao = alts[chave]?.posicao;

	const doCsv = creditos.get(id);
	const credito = doCsv?.trim() || CREDITO_PADRAO;
	if (!doCsv?.trim()) creditoPadrao.push(`${id} (${doCsv === undefined ? 'fora do CSV' : 'crédito vazio no CSV'})`);

	const linha = { id, tipo, dims: '—', credito, alt, status: '', plano: null };
	try {
		const plano = await planejarCapa({
			id,
			origem: join(DIR_IMAGENS, nome),
			tipo,
			credito,
			alt,
			posicao,
			substituir: true,
		});
		linha.dims = `${plano.largura}×${plano.altura}`;
		const problemas = [...plano.problemas];
		if (alt.length > ALT_MAX) problemas.push(`alt com ${alt.length} caracteres (máx. ${ALT_MAX})`);
		if (problemas.length) {
			linha.status = `reprovada: ${problemas.join('; ')}`;
		} else {
			linha.plano = plano;
			linha.status = plano.avisos.length ? `ok, ${plano.avisos.join('; ')}` : 'ok';
			if (plano.avisos.length) abaixoIdeal.push(`${id} (${linha.dims})`);
			const extras = [];
			if (plano.arquivoAntigo) extras.push('substitui arquivo antigo');
			if (plano.tinhaLicenca) extras.push('remove coverLicencaUrl');
			if (posicao) extras.push(`coverPosicao "${posicao}"`);
			if (extras.length) linha.status += ` (${extras.join(', ')})`;
		}
	} catch (err) {
		linha.status = `reprovada: ${err.message}`;
	}
	linhas.push(linha);
}

const esc = (s) => String(s).replaceAll('|', '\\|');
console.log(aplicar ? 'APLICANDO LOTE\n' : 'SIMULAÇÃO (sem --apply): nada será gravado\n');
console.log('| id | tipo | dimensões | crédito | alt proposto | status |');
console.log('|---|---|---|---|---|---|');
for (const l of linhas) {
	console.log(`| ${esc(l.id)} | ${l.tipo} | ${l.dims} | ${esc(l.credito)} | ${esc(l.alt || '(sem alt)')} | ${esc(l.status)} |`);
}

const aprovadas = linhas.filter((l) => l.plano);
const reprovadas = linhas.filter((l) => !l.plano);

if (aplicar) {
	for (const l of aprovadas) {
		try {
			await aplicarCapa(l.plano);
		} catch (err) {
			console.error(`falha ao aplicar ${l.id}-${l.tipo}: ${err.message}`);
		}
	}
}

console.log(`\nResumo: ${aprovadas.length} aprovada(s), ${reprovadas.length} reprovada(s), ${ignorados.length} arquivo(s) ignorado(s).`);
if (abaixoIdeal.length) console.log(`Abaixo de 1200px (sem imagem grande no Discover): ${abaixoIdeal.join(', ')}`);
if (creditoPadrao.length) console.log(`Crédito "${CREDITO_PADRAO}" por falta de dado: ${creditoPadrao.join(', ')}`);
const soDivulgacao = linhas.filter((l) => l.credito === CREDITO_PADRAO && !creditoPadrao.some((c) => c.startsWith(`${l.id} `)));
if (soDivulgacao.length) console.log(`Crédito "${CREDITO_PADRAO}" vindo do CSV (distribuidora a confirmar): ${soDivulgacao.map((l) => l.id).join(', ')}`);
if (reprovadas.length) console.log(`Reprovadas: ${reprovadas.map((l) => `${l.id}-${l.tipo}`).join(', ')}`);
if (ignorados.length) console.log(`Ignorados (nome fora do padrão): ${ignorados.join(', ')}`);
if (!aplicar) console.log('\nRode com --apply para gravar.');
