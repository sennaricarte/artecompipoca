/**
 * Utilitários de frontmatter Markdown (compartilhados entre scripts).
 */

/**
 * @param {string} raw
 */
export function splitFrontmatter(raw) {
	const text = String(raw || '').replace(/^\uFEFF/, '');
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n)?/);
	if (!m) return null;
	return {
		fm: m[1],
		body: text.slice(m[0].length),
		open: '---\n',
		close: '\n---\n',
	};
}

/**
 * @param {string} fm
 * @param {string} key
 */
export function getScalar(fm, key) {
	const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
	if (!m) return '';
	let v = m[1].trim();
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		v = v.slice(1, -1);
	}
	return v;
}

/**
 * @param {unknown} v
 */
export function yamlScalar(v) {
	if (typeof v === 'number') return String(v);
	const s = String(v);
	if (/^[\w.+-]+$/u.test(s) && !/^(?:true|false|null|yes|no)$/i.test(s)) {
		return s;
	}
	return JSON.stringify(s);
}

/**
 * @param {string} s
 */
export function csvEscape(s) {
	const v = String(s ?? '');
	if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
	return v;
}
