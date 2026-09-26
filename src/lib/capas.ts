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

export const COR_PIPOCA = '#ffc83d';
export const COR_FUNDO_SITE = '#0f0f12';

/** Fonte única das cores por editoria (capas tipográficas, molduras e imagens OG). */
export const TEMAS_CAPA: Record<EditoriaId, TemaCapa> = {
	cinema: {
		fundo: 'linear-gradient(145deg, #6b1520 0%, #a11e2a 45%, #c92a35 100%)',
		texto: '#ffffff',
		rotulo: '#ffe8ea',
		seloBg: COR_FUNDO_SITE,
		seloTexto: COR_PIPOCA,
		claro: false,
	},
	series: {
		fundo: 'linear-gradient(145deg, #071525 0%, #0f2a4a 50%, #163d6b 100%)',
		texto: '#ffffff',
		rotulo: '#c5d8f0',
		seloBg: COR_PIPOCA,
		seloTexto: COR_FUNDO_SITE,
		claro: false,
	},
	quadrinhos: {
		fundo: 'linear-gradient(145deg, #e6a820 0%, #ffc83d 55%, #ffe08a 100%)',
		texto: '#1a1200',
		rotulo: '#3d2e00',
		seloBg: COR_FUNDO_SITE,
		seloTexto: COR_PIPOCA,
		claro: true,
	},
	musica: {
		fundo: 'linear-gradient(145deg, #1e0f33 0%, #3a1a5c 50%, #5a2a8a 100%)',
		texto: '#ffffff',
		rotulo: '#e0d0f5',
		seloBg: COR_PIPOCA,
		seloTexto: COR_FUNDO_SITE,
		claro: false,
	},
};
