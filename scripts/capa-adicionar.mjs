/**
 * Adiciona a capa (cena horizontal) ou o cartaz (vertical) de um post.
 *
 * Uso:
 *   pnpm capa:adicionar <id> "<caminho da imagem>" --tipo=cena|cartaz
 *     --credito="Divulgação/Distribuidora" --alt="..."
 *     [--posicao="center 30%"] [--substituir] [--apply]
 *
 * cena:   horizontal, largura >= 1000px (abaixo de 1280px avisa "abaixo do ideal")
 *         → cover, coverAlt, coverCredito, coverPosicao (remove coverLicencaUrl).
 * cartaz: vertical, altura >= 400px → cartaz, cartazAlt, cartazCredito.
 *         Resenhas de álbum: quadrado (0,95–1,05) com lado >= 500px.
 * Converte para JPEG q85, lado maior até 2000px, em src/assets/capas/{id}-{tipo}.jpg.
 * Sem --apply só mostra o que faria.
 */
import { relative } from 'node:path';
import { aplicarCapa, planejarCapa, RAIZ } from './lib/capas.mjs';

const USO =
	'Uso: pnpm capa:adicionar <id> "<imagem>" --tipo=cena|cartaz --credito="..." --alt="..." [--posicao="center 30%"] [--substituir] [--apply]';

function lerArgs(argv) {
	const posicionais = [];
	const opcoes = {};
	for (const arg of argv) {
		const m = arg.match(/^--([\w-]+)(?:=(.*))?$/s);
		if (m) opcoes[m[1]] = m[2] ?? true;
		else posicionais.push(arg);
	}
	return { posicionais, opcoes };
}

const { posicionais, opcoes } = lerArgs(process.argv.slice(2).filter((a) => a !== '--'));
const [id, origem] = posicionais;

if (!id || !origem || typeof opcoes.tipo !== 'string') {
	console.error(USO);
	process.exit(1);
}

const aplicar = opcoes.apply === true;
const rel = (p) => relative(RAIZ, p).replaceAll('\\', '/');

try {
	const plano = await planejarCapa({
		id,
		origem,
		tipo: /** @type {'cena' | 'cartaz'} */ (opcoes.tipo),
		credito: typeof opcoes.credito === 'string' ? opcoes.credito : '',
		alt: typeof opcoes.alt === 'string' ? opcoes.alt : '',
		posicao: typeof opcoes.posicao === 'string' ? opcoes.posicao : undefined,
		substituir: opcoes.substituir === true,
	});

	console.log(`${aplicar ? 'APLICANDO' : 'SIMULAÇÃO (sem --apply)'}`);
	console.log(`  post:      ${plano.colecao}/${plano.id} (${rel(plano.caminhoPost)})`);
	console.log(`  tipo:      ${plano.tipo}`);
	console.log(`  origem:    ${rel(plano.caminhoOrigem)} (${plano.largura}×${plano.altura})`);
	console.log(`  destino:   ${rel(plano.destino)} (JPEG q85, lado maior ≤ 2000px)`);
	for (const [k, v] of Object.entries(plano.definir)) console.log(`  + ${k}: ${v}`);
	for (const k of plano.remover) console.log(`  - ${k}`);
	if (plano.arquivoAntigo) console.log(`  apagar:    ${rel(plano.arquivoAntigo)}`);
	for (const a of plano.avisos) console.log(`  aviso:     ${a}`);

	if (plano.problemas.length) {
		console.error(`\nReprovado:\n${plano.problemas.map((p) => `  - ${p}`).join('\n')}`);
		process.exit(1);
	}

	if (aplicar) {
		await aplicarCapa(plano);
		console.log('\nOK: imagem convertida e frontmatter atualizado.');
	} else {
		console.log('\nNada foi gravado. Rode com --apply para aplicar.');
	}
} catch (err) {
	console.error(`Erro: ${err.message}`);
	process.exit(1);
}
