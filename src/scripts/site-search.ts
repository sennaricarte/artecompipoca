export type SearchItem =
	| {
			type: 'artigo';
			title: string;
			description: string;
			category: string;
			url: string;
			pubDate: string;
	  }
	| {
			type: 'resenha';
			title: string;
			description: string;
			category: string;
			obra: string;
			url: string;
			pubDate: string;
	  };

const typeOrder: Record<SearchItem['type'], number> = {
	resenha: 0,
	artigo: 1,
};

const typeLabels: Record<SearchItem['type'], string> = {
	artigo: 'Artigo',
	resenha: 'Resenha',
};

export function getSearchTypeLabel(type: SearchItem['type']): string {
	return typeLabels[type];
}

export function normalizeSearchText(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '');
}

function itemHaystack(item: SearchItem): string {
	const parts = [item.title, item.description, item.category];
	if (item.type === 'resenha') parts.push(item.obra);
	return normalizeSearchText(parts.join(' '));
}

export function searchItems(
	items: SearchItem[],
	query: string,
	limit = 80,
): SearchItem[] {
	const term = normalizeSearchText(query.trim());
	if (!term) return [];

	const tokens = term.split(/\s+/).filter(Boolean);

	return items
		.filter((item) => {
			const hay = itemHaystack(item);
			return tokens.every((t) => hay.includes(t));
		})
		.sort((a, b) => {
			const titleA = normalizeSearchText(a.title);
			const titleB = normalizeSearchText(b.title);
			const exactA = titleA.includes(term) ? 0 : 1;
			const exactB = titleB.includes(term) ? 0 : 1;
			if (exactA !== exactB) return exactA - exactB;
			return typeOrder[a.type] - typeOrder[b.type];
		})
		.slice(0, limit);
}

export function formatSearchDate(iso: string): string {
	return new Date(iso).toLocaleDateString('pt-BR', {
		day: 'numeric',
		month: 'long',
		year: 'numeric',
	});
}
