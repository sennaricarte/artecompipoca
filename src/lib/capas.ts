import type { EditoriaId } from './conteudo';

export interface TemaCapa {
	/** CSS `background` (degradê). */
	fundo: string;
	texto: string;
	rotulo: string;
	seloBg: string;
	seloTexto: string;
	/** Fundo claro: elementos em pipoca precisam de apoio escuro. */
	claro: boolean;
}

export interface VarianteCapa extends Omit<TemaCapa, 'fundo'> {
	nome: string;
	/** Paradas do degradê, do canto mais escuro ao mais claro. */
	cores: [string, string, string];
	/** Peso relativo no sorteio determinístico (padrão 1). */
	peso?: number;
}

export interface CapaResolvida extends TemaCapa {
	editoria: EditoriaId;
	variante: string;
	angulo: number;
}

export const COR_PIPOCA = '#ffc83d';
export const COR_FUNDO_SITE = '#0f0f12';

const SELO_ESCURO = { seloBg: COR_FUNDO_SITE, seloTexto: COR_PIPOCA };
const SELO_PIPOCA = { seloBg: COR_PIPOCA, seloTexto: COR_FUNDO_SITE };
const TEXTO_CLARO = { texto: '#ffffff', claro: false };

/**
 * Fonte única das cores por editoria (capas tipográficas, molduras e imagens OG).
 * Toda combinação texto/rótulo × parada do degradê tem contraste ≥ 4,5:1.
 */
export const VARIANTES_CAPA: Record<EditoriaId, VarianteCapa[]> = {
	cinema: [
		{ nome: 'balde', cores: ['#6b1520', '#a11e2a', '#b8232f'], rotulo: '#ffe8ea', ...TEXTO_CLARO, ...SELO_ESCURO },
		{ nome: 'vinho', cores: ['#26060d', '#4a0c1a', '#6a1427'], rotulo: '#f5d5dc', ...TEXTO_CLARO, ...SELO_PIPOCA },
		{ nome: 'vermelho-alaranjado', cores: ['#6a180a', '#8f2911', '#a3341a'], rotulo: '#fff0e8', ...TEXTO_CLARO, ...SELO_ESCURO },
	],
	series: [
		{ nome: 'azul-profundo', cores: ['#071525', '#0f2a4a', '#163d6b'], rotulo: '#c5d8f0', ...TEXTO_CLARO, ...SELO_PIPOCA },
		{ nome: 'petroleo', cores: ['#03171a', '#0a353b', '#0f5058'], rotulo: '#c2e6ea', ...TEXTO_CLARO, ...SELO_PIPOCA },
		{ nome: 'indigo', cores: ['#100d33', '#1f1a5e', '#2e2885'], rotulo: '#d4d0f7', ...TEXTO_CLARO, ...SELO_PIPOCA },
	],
	quadrinhos: [
		{
			nome: 'amarelo-pipoca',
			cores: ['#e6a820', '#ffc83d', '#ffe08a'],
			texto: '#1a1200',
			rotulo: '#3d2e00',
			claro: true,
			peso: 1,
			...SELO_ESCURO,
		},
		{ nome: 'ambar-escuro', cores: ['#3d2400', '#5e3a00', '#7a4c00'], rotulo: '#ffe3a8', ...TEXTO_CLARO, peso: 2, ...SELO_PIPOCA },
		{
			nome: 'mostarda',
			cores: ['#c79e22', '#d6ad32', '#e2bd4a'],
			texto: '#1a1200',
			rotulo: '#231a00',
			claro: true,
			peso: 2,
			...SELO_ESCURO,
		},
	],
	musica: [
		{ nome: 'roxo', cores: ['#1e0f33', '#3a1a5c', '#5a2a8a'], rotulo: '#e0d0f5', ...TEXTO_CLARO, ...SELO_PIPOCA },
		{ nome: 'magenta-escuro', cores: ['#2b0720', '#550e40', '#781a5a'], rotulo: '#f7d3ea', ...TEXTO_CLARO, ...SELO_PIPOCA },
		{ nome: 'violeta', cores: ['#1c1040', '#35206e', '#4d3196'], rotulo: '#ddd2fa', ...TEXTO_CLARO, ...SELO_PIPOCA },
	],
};

const ANGULOS = [120, 135, 150, 165, 200, 225] as const;

/** FNV-1a de 32 bits: estável entre builds e entre o site e o gerador de OG. */
export function hashId(id: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function degrade(cores: readonly string[], angulo: number): string {
	const [a, b, c] = cores;
	return `linear-gradient(${angulo}deg, ${a} 0%, ${b} 50%, ${c} 100%)`;
}

/** Capa de um post: mesma variante e ângulo sempre que o id for o mesmo. */
export function capaDoPost(editoria: EditoriaId, id: string): CapaResolvida {
	const variantes = VARIANTES_CAPA[editoria];
	const h = hashId(`${editoria}:${id}`);
	const pesoTotal = variantes.reduce((s, v) => s + (v.peso ?? 1), 0);
	let alvo = h % pesoTotal;
	let escolhida = variantes[0];
	for (const v of variantes) {
		const peso = v.peso ?? 1;
		if (alvo < peso) {
			escolhida = v;
			break;
		}
		alvo -= peso;
	}
	const angulo = ANGULOS[(h >>> 8) % ANGULOS.length];
	const { nome, cores, peso: _peso, ...visual } = escolhida;
	return {
		...visual,
		editoria,
		variante: nome,
		angulo,
		fundo: degrade(cores, angulo),
	};
}

/** Tema neutro da editoria (primeira variante, ângulo padrão): OG padrão e afins. */
export function temaEditoria(editoria: EditoriaId): TemaCapa {
	const { cores, nome: _n, peso: _p, ...resto } = VARIANTES_CAPA[editoria][0];
	return { ...resto, fundo: degrade(cores, 145) };
}
