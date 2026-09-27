/**
 * Remark: insere minifichas após headings h2 que correspondem a obras do frontmatter.
 */

/** @type {Map<string, string[]>} */
const unmatchedByFile = new Map();
const INTERVALO_ANOS = '–';

/**
 * @param {string} s
 */
export function normalizeHeading(s) {
	return String(s || '')
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

/**
 * @param {import('mdast').Heading} node
 */
function headingPlainText(node) {
	/** @param {import('mdast').PhrasingContent} n */
	function walk(n) {
		if (n.type === 'text') return n.value;
		if ('children' in n && Array.isArray(n.children)) {
			return n.children.map(walk).join('');
		}
		return '';
	}
	return walk(node).trim();
}

/**
 * @param {string} text
 */
function textNode(text) {
	return { type: 'text', value: text };
}

/**
 * @param {string} url
 * @param {string} label
 */
function linkNode(url, label) {
	return {
		type: 'link',
		url,
		data: {
			hProperties: {
				target: '_blank',
				rel: 'noopener',
			},
		},
		children: [textNode(label)],
	};
}

/**
 * @param {import('mdast').PhrasingContent[]} children
 */
function minifichaParagraph(children) {
	return {
		type: 'paragraph',
		data: {
			hProperties: {
				class: 'minificha',
			},
		},
		children,
	};
}

/**
 * @param {any} obra
 */
function buildMinifichaChildren(obra) {
	/** @type {import('mdast').PhrasingContent[]} */
	const parts = [];
	const query = encodeURIComponent(obra.tituloOriginal || obra.titulo);
	const jwUrl = `https://www.justwatch.com/br/busca?q=${query}`;

	if (obra.tipo === 'filme') {
		if (obra.ano != null) parts.push(textNode(String(obra.ano)));
		if (obra.direcao?.length) {
			if (parts.length) parts.push(textNode(' · '));
			parts.push(textNode(`Direção: ${obra.direcao.join(', ')}`));
		}
	} else {
		if (obra.ano != null) {
			if (obra.anoFim != null) {
				parts.push(textNode(`${obra.ano}${INTERVALO_ANOS}${obra.anoFim}`));
			} else {
				parts.push(textNode(`desde ${obra.ano}`));
			}
		}
		if (obra.temporadas != null) {
			if (parts.length) parts.push(textNode(' · '));
			parts.push(
				textNode(
					`${obra.temporadas} ${obra.temporadas === 1 ? 'temporada' : 'temporadas'}`,
				),
			);
		}
		if (obra.criacao?.length) {
			if (parts.length) parts.push(textNode(' · '));
			parts.push(textNode(`Criação: ${obra.criacao.join(', ')}`));
		}
	}

	if (parts.length) parts.push(textNode(' · '));
	parts.push(linkNode(jwUrl, 'Ver onde assistir'));

	return parts;
}

/**
 * @param {string} raw
 */
function parseObrasFromFrontmatter(raw) {
	const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return [];
	const fm = m[1];
	if (!/^obras:/m.test(fm)) return [];

	/** @type {any[]} */
	const obras = [];
	/** @type {any} */
	let current = null;
	let inObras = false;
	let currentListKey = '';

	for (const line of fm.split('\n')) {
		if (/^obras:\s*$/.test(line)) {
			inObras = true;
			continue;
		}
		if (inObras && /^[A-Za-z_][\w-]*:/.test(line) && !/^  /.test(line)) {
			break;
		}
		if (!inObras) continue;

		const item = line.match(/^  - titulo:\s*(.+)$/);
		if (item) {
			if (current) obras.push(current);
			current = { titulo: unquoteYaml(item[1].trim()) };
			currentListKey = '';
			continue;
		}

		if (!current) continue;

		const arrItem = line.match(/^    - (.+)$/);
		if (arrItem && currentListKey) {
			if (!Array.isArray(current[currentListKey])) current[currentListKey] = [];
			current[currentListKey].push(unquoteYaml(arrItem[1].trim()));
			continue;
		}

		const field = line.match(/^    ([a-zA-Z]+):\s*(.*)$/);
		if (!field) continue;
		const [, key, rawVal] = field;
		if (rawVal === '') {
			currentListKey = key;
			current[key] = [];
			continue;
		}
		currentListKey = '';
		if (key === 'ano' || key === 'anoFim' || key === 'temporadas') {
			current[key] = Number(rawVal);
		} else {
			current[key] = unquoteYaml(rawVal.trim());
		}
	}
	if (current) obras.push(current);
	return obras.filter((o) => o.titulo);
}

/**
 * @param {string} v
 */
function unquoteYaml(v) {
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		return v.slice(1, -1);
	}
	return v;
}

/**
 * @param {any} file
 */
function getObras(file) {
	const fromAstro = file.data?.astro?.frontmatter?.obras;
	if (Array.isArray(fromAstro) && fromAstro.length) return fromAstro;
	return parseObrasFromFrontmatter(String(file.value || ''));
}

/**
 * @param {import('mdast').Root} tree
 * @param {any} parent
 * @param {number} index
 * @param {{ index: number, parent: any, node: any }[]} insertions
 */
function collectHeadings(tree, parent, index, insertions) {
	if (tree.type === 'heading' && tree.depth === 2 && parent) {
		insertions.push({ node: tree, parent, index });
	}
	if ('children' in tree && Array.isArray(tree.children)) {
		for (let i = 0; i < tree.children.length; i++) {
			collectHeadings(tree.children[i], tree, i, insertions);
		}
	}
}

export function flushMinifichaWarnings() {
	if (unmatchedByFile.size === 0) return;
	console.warn('\n[minifichas] Obras do frontmatter sem heading correspondente:');
	for (const [file, titles] of unmatchedByFile) {
		for (const titulo of titles) {
			console.warn(`  - ${file}: "${titulo}"`);
		}
	}
	unmatchedByFile.clear();
}

/** @returns {(tree: import('mdast').Root, file: import('vfile').VFile) => void} */
export default function remarkMinifichas() {
	return (tree, file) => {
		const obras = getObras(file);
		if (!obras.length) return;

		/** @type {Map<string, any>} */
		const byTitle = new Map();
		for (const obra of obras) {
			byTitle.set(normalizeHeading(obra.titulo), obra);
		}

		/** @type {{ index: number, parent: any, node: any }[]} */
		const headings = [];
		collectHeadings(tree, null, 0, headings);

		/** @type {Set<string>} */
		const matched = new Set();

		/** @type {{ index: number, parent: any, node: any }[]} */
		const toInsert = [];

		for (const { node, parent, index } of headings) {
			const plain = headingPlainText(node);
			const obra = byTitle.get(normalizeHeading(plain));
			if (!obra) continue;
			matched.add(normalizeHeading(obra.titulo));
			const children = buildMinifichaChildren(obra);
			if (!children.length) continue;
			toInsert.push({
				index: index + 1,
				parent,
				node: minifichaParagraph(children),
			});
		}

		toInsert.sort((a, b) => {
			if (a.parent !== b.parent) return 0;
			return b.index - a.index;
		});

		for (const ins of toInsert) {
			ins.parent.children.splice(ins.index, 0, ins.node);
		}

		/** @type {string[]} */
		const missing = [];
		for (const obra of obras) {
			const key = normalizeHeading(obra.titulo);
			if (!matched.has(key)) missing.push(obra.titulo);
		}
		if (missing.length) {
			unmatchedByFile.set(file.path || file.history?.[0] || 'desconhecido', missing);
		}
	};
}
