/**
 * Slug a partir de título limpo (decisões manuais / frontmatter).
 * @param {string} titulo
 * @returns {string}
 */
export function slugifyTitulo(titulo) {
	return String(titulo || '')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[()]/g, ' ')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * Slug legado derivado da URL (sem titulo_limpo).
 * @param {string} urlNormalizada
 * @returns {string}
 */
export function slugFromUrl(urlNormalizada) {
	let path;
	try {
		path = new URL(urlNormalizada).pathname;
	} catch {
		path = urlNormalizada;
	}
	let slug = path.replace(/^\/+|\/+$/g, '').split('/').pop() || '';
	slug = slug.replace(/-(critica|resenha|review)$/i, '');
	slug = slug.replace(/-[23]$/, '');
	slug = slug.replace(/^review-/i, '');
	return slug;
}

/**
 * @param {{ titulo_limpo?: string, url_normalizada?: string, legacyUrl?: string }} row
 * @returns {string}
 */
export function resolveSlug(row) {
	const tituloLimpo = (row.titulo_limpo || row.title || '').trim();
	if (tituloLimpo) return slugifyTitulo(tituloLimpo);
	return slugFromUrl(row.url_normalizada || row.legacyUrl || '');
}
