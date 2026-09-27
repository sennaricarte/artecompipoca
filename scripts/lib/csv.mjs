import { csvEscape } from './frontmatter.mjs';

/**
 * @param {string} line
 */
export function splitCsvLine(line) {
	/** @type {string[]} */
	const out = [];
	let cur = '';
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (q && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else q = !q;
			continue;
		}
		if (c === ',' && !q) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	out.push(cur);
	return out;
}

/**
 * @param {string} text
 */
export function parseCsvWithHeaders(text) {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { headers: [], rows: [] };
	const headers = splitCsvLine(lines[0]);
	const rows = lines.slice(1).map((line) => {
		const cols = splitCsvLine(line);
		/** @type {Record<string, string>} */
		const row = {};
		headers.forEach((h, i) => {
			row[h] = cols[i] ?? '';
		});
		return row;
	});
	return { headers, rows };
}

/**
 * @param {string} text
 */
export function parseCsv(text) {
	return parseCsvWithHeaders(text).rows;
}

/**
 * @param {string[]} headers
 * @param {Record<string, string>[]} rows
 */
export function serializeCsv(headers, rows) {
	return (
		headers.join(',') +
		'\n' +
		rows.map((r) => headers.map((h) => csvEscape(r[h] ?? '')).join(',')).join('\n') +
		'\n'
	);
}
