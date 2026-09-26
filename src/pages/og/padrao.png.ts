import type { APIRoute } from 'astro';
import { gerarOgPadrao } from '../../lib/og';

export const GET: APIRoute = async () => {
	const png = await gerarOgPadrao();
	return new Response(new Uint8Array(png), {
		headers: { 'Content-Type': 'image/png' },
	});
};
