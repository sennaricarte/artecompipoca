export const site = {
	nome: 'Arte Com Pipoca',
	url: 'https://artecompipoca.net',
	emailContato: 'contato@artecompipoca.net',
	whatsapp: '5511961485763',
	whatsappExibicao: '(11) 96148-5763',
} as const;

/**
 * @param {string} [mensagem]
 * @returns {string}
 */
export function linkWhatsapp(mensagem?: string): string {
	const base = `https://wa.me/${site.whatsapp}`;
	if (!mensagem) return base;
	return `${base}?text=${encodeURIComponent(mensagem)}`;
}
