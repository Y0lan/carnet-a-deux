import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
export async function build(apiUrl) {
  const url = new URL(apiUrl);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) || url.username || url.password || url.hash || url.search || url.pathname !== '/api/trip') throw new Error('Adresse du service invalide. Utilise une URL HTTPS terminée par /api/trip, sans code ni paramètres.');
  const output = resolve(root, 'dist');
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  // La liste publique est l'unique source du build. Aucun fichier privé n'est copié.
  await cp(resolve(root, 'public'), output, { recursive: true });
  await writeFile(resolve(output, 'config.js'), `export const API_URL = ${JSON.stringify(url.href)};\n`);
  await writeFile(resolve(output, '.nojekyll'), '');
  return output;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const option = process.argv.find((value) => value.startsWith('--api='));
    const api = option?.slice(6) || process.env.PUBLIC_API_URL;
    if (!api) throw new Error('Indique PUBLIC_API_URL ou --api=https://ton-service.workers.dev/api/trip.');
    console.log(`Site public préparé : ${await build(api)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
