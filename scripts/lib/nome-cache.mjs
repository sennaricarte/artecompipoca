/**
 * Nome do arquivo de cache HTML a partir da url_normalizada.
 * Home → "_home.html"; "/" → "__"; caracteres inválidos no Windows → "_".
 * @param {string} urlNormalizada
 * @returns {string}
 */
export function cacheFileName(urlNormalizada) {
	let path;
	try {
		path = new URL(urlNormalizada).pathname;
	} catch {
		path = urlNormalizada;
	}

	let nome = path.replace(/^\/+|\/+$/g, '');
	if (!nome) nome = '_home';
	nome = nome.replace(/\//g, '__');
	nome = nome.replace(/[<>:"|?*\\]/g, '_');
	return `${nome}.html`;
}
