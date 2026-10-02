#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

function log(...args) {
  console.log(...args);
}

function usage() {
  console.log('Uso: pnpm autor:foto <id-do-autor> "<caminho-da-imagem>" [--apply]');
}

const argv = process.argv.slice(2);
if (argv.length < 2) {
  usage();
  process.exit(1);
}

const id = argv[0];
const imagePath = argv[1];
const apply = argv.includes('--apply');

const repoRoot = process.cwd();
const autoresPath = path.join(repoRoot, 'src', 'data', 'autores.json');
const outputDir = path.join(repoRoot, 'src', 'assets', 'autores');
const outputRel = (id) => `../../assets/autores/${id}.jpg`;
const outputPath = path.join(outputDir, `${id}.jpg`);

try {
  const autoresRaw = await fs.readFile(autoresPath, 'utf8');
  const autores = JSON.parse(autoresRaw);
  const autor = autores.find((a) => a.id === id);
  if (!autor) {
    console.error(`Autor com id "${id}" não encontrado em ${autoresPath}`);
    process.exit(2);
  }

  // Validate extension
  const ext = path.extname(imagePath).toLowerCase();
  const allowed = ['.jpg', '.jpeg', '.png', '.webp'];
  if (!allowed.includes(ext)) {
    console.error('Formato de imagem não suportado. Aceito: jpg, jpeg, png, webp.');
    process.exit(3);
  }

  // Read image and check metadata
  let buffer;
  try {
    buffer = await fs.readFile(path.resolve(repoRoot, imagePath));
  } catch (err) {
    console.error('Não foi possível ler o arquivo de imagem:', err.message);
    process.exit(4);
  }

  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) {
    console.error('Não foi possível determinar largura/altura da imagem.');
    process.exit(5);
  }
  if (meta.width < 200 || meta.height < 200) {
    console.error('Imagem com dimensões muito pequenas. Exige pelo menos 200x200px.');
    process.exit(6);
  }

  log(`Autor: ${autor.nome} (id: ${id})`);
  log(`Imagem de origem: ${imagePath} (${meta.width}x${meta.height}, ${meta.format})`);
  log(`Saída prevista: ${outputPath} (JPEG q85, resize max 400x400 mantendo proporção)`);
  log(`Campo 'foto' que será definido em autores.json: "${outputRel(id)}"`);

  if (!apply) {
    log('\nDRY RUN — nenhuma alteração será feita. Use --apply para aplicar as mudanças.');
    process.exit(0);
  }

  // Ensure output dir exists
  await fs.mkdir(outputDir, { recursive: true });

  // Process and write JPEG q85 resized
  await sharp(buffer)
    .rotate()
    .resize({ width: 400, height: 400, fit: 'inside' })
    .jpeg({ quality: 85 })
    .toFile(outputPath);

  // Update autores.json
  const updated = autores.map((a) => {
    if (a.id === id) {
      return { ...a, foto: outputRel(id) };
    }
    return a;
  });
  // preserve tab indentation similar to project files
  await fs.writeFile(autoresPath, JSON.stringify(updated, null, '\t') + '\n', 'utf8');

  log('\nOperação concluída com sucesso.');
  log(`Imagem salva em: ${outputPath}`);
  log(`autores.json atualizado: campo 'foto' de "${id}" definido como "${outputRel(id)}"`);
  process.exit(0);
} catch (err) {
  console.error('Erro:', err);
  process.exit(10);
}

