/**
 * Lógica compartilhada de localização/limpeza do corpo do post (temas Arte com Pipoca).
 * Usada por wayback-extrair e wayback-converter.
 */
import * as cheerio from 'cheerio';

/** Contas genéricas do WordPress → autor_id "redacao". */
const AUTORES_REDACAO = new Set([
	'',
	'pipoca',
	'equipe pipocacast',
	'da redacao',
	'admin',
]);

/**
 * @param {string} text
 * @returns {string}
 */
export function stripAccents(text) {
	return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Slug ASCII a partir do nome do autor.
 * @param {string} nome
 * @returns {string}
 */
export function slugifyAutor(nome) {
	return stripAccents(nome || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Normaliza o autor original para a coluna autor_id.
 * Contas genéricas → "redacao"; demais → slug do nome.
 * @param {string} [nome]
 * @returns {string}
 */
export function normalizeAutorId(nome) {
	const raw = (nome || '').replace(/\s+/g, ' ').trim();
	const key = stripAccents(raw).toLowerCase();
	if (AUTORES_REDACAO.has(key)) return 'redacao';
	return slugifyAutor(raw) || 'redacao';
}

/** Temas do site: #post-content (tema novo) e .post-entry (tema antigo). */
export const CONTENT_SELECTORS = [
	'#post-content',
	'.post-entry',
	'.entry-content',
	'.post-content',
	'.td-post-content',
	'article .content',
	'article',
];

export const REMOVE_FROM_CONTENT = [
	'script',
	'style',
	'iframe',
	'form',
	'noscript',
	'.sharedaddy',
	'.jp-relatedposts',
	'.addtoany',
	'.comments',
	'#comments',
	'.comment-respond',
	'.wpcf7',
	'.adsbygoogle',
	'.code-block',
	'.share-post',
	'.share-title',
	'.content-social',
	'.fb-social-plugin',
	'.fb-like',
	'.fb-send',
	'.fb-comments',
	'.homepage-widget',
	'.related-item',
	'.nav-next-prev',
	'.blog-post-content',
	'.post-tags',
	'.post-categories-wrapper',
	'.post-meta',
	'.post-meta-tags',
	'.post-meta-cats',
	'.post-author',
	'.heading-author',
	'.heading-date',
	'.wp-caption',
	'.wp-caption-text',
].join(', ');

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<import('cheerio').Element>} clone
 */
export function scrubContentClone($, clone) {
	clone.find(REMOVE_FROM_CONTENT).remove();
	clone.find('a').each((_, a) => {
		const t = $(a).text().replace(/\s+/g, ' ').trim().toLowerCase();
		if (/coment[aá]rios?/.test(t) || t === 'comments') {
			$(a).remove();
		}
	});
	clone.find('*').addBack().contents().each((_, node) => {
		if (node.type !== 'text') return;
		const raw = node.data ?? '';
		if (/^\s*(comments|coment[aá]rios?)\s*$/i.test(raw)) {
			$(node).remove();
		}
	});
}

/**
 * @param {import('cheerio').Element} el
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string}
 */
function describeDensitySelector(el, $) {
	const tag = (el.tagName || 'div').toLowerCase();
	const id = ($(el).attr('id') || '').trim();
	const classes = ($(el).attr('class') || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.join('.');
	let desc = tag;
	if (id) desc += `#${id}`;
	if (classes) desc += `.${classes}`;
	return `densidade:${desc}`;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Element} el
 * @returns {number}
 */
function countDirectTextParagraphs($, el) {
	let n = 0;
	$(el)
		.children('p')
		.each((_, p) => {
			if ($(p).text().replace(/\s+/g, ' ').trim()) n += 1;
		});
	return n;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ node: import('cheerio').Cheerio<import('cheerio').Element>, label: string } | null}
 */
export function findByParagraphDensity($) {
	/** @type {import('cheerio').Element | null} */
	let best = null;
	let bestCount = 0;

	$('div, article, section, td').each((_, el) => {
		const count = countDirectTextParagraphs($, el);
		if (count >= 2 && count > bestCount) {
			bestCount = count;
			best = el;
		}
	});

	if (!best) return null;
	return {
		node: $(best),
		label: describeDensitySelector(best, $),
	};
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Cheerio<import('cheerio').Element>} node
 * @returns {number}
 */
export function countWordsFromNode($, node) {
	const clone = node.clone();
	scrubContentClone($, clone);
	const text = clone.text().replace(/\s+/g, ' ').trim();
	if (!text) return 0;
	return text.split(/\s+/).filter(Boolean).length;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ node: import('cheerio').Cheerio<import('cheerio').Element>, seletor: string } | null}
 */
export function findContentNode($) {
	for (const selector of CONTENT_SELECTORS) {
		const node = $(selector).first();
		if (!node.length) continue;
		if (countWordsFromNode($, node) > 0) {
			return { node, seletor: selector };
		}
	}

	const dense = findByParagraphDensity($);
	if (dense && countWordsFromNode($, dense.node) > 0) {
		return { node: dense.node, seletor: dense.label };
	}

	return null;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @returns {{ palavras: number, seletor_usado: string }}
 */
export function extractPalavras($) {
	const found = findContentNode($);
	if (!found) return { palavras: 0, seletor_usado: 'nenhum' };
	return {
		palavras: countWordsFromNode($, found.node),
		seletor_usado: found.seletor,
	};
}

/**
 * HTML do container limpo (scrub padrão + unwrap #HOTWordsTxt), para conversão MD.
 * @param {string} htmlDocumento
 * @returns {{ html: string, seletor: string } | null}
 */
export function getScrubbedContentHtml(htmlDocumento) {
	const $ = cheerio.load(htmlDocumento);
	const found = findContentNode($);
	if (!found) return null;

	const clone = found.node.clone();
	scrubContentClone($, clone);

	clone.find('#HOTWordsTxt, [id="HOTWordsTxt"]').each((_, el) => {
		$(el).replaceWith($(el).contents());
	});

	return { html: $.html(clone) || '', seletor: found.seletor };
}
