import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { build } from './build.mjs';
import { applyEnrichment } from './enrich.mjs';
import { validateData } from '../public/schema.js';

const root = resolve(import.meta.dirname, '..'), privateDir = join(root, '.private');
const run = promisify(execFile), repo = process.env.GITHUB_REPO || 'carnet-a-deux';
const workerName = 'carnet-a-deux-sync', statePath = join(privateDir, 'deployment.json');
const secrets = [];
let auth, progress, user;
async function saved(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
async function remember() { await writeFile(statePath, JSON.stringify(progress, null, 2), { mode: 0o600 }); }
async function credentials() {
  let github = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!github) { try { github = (await run('gh', ['auth', 'token'], { cwd: root })).stdout.trim(); } catch { throw new Error('Connexion GitHub requise. Exécute gh auth login, puis relance npm run deploy.'); } }
  let cloudflare = process.env.CLOUDFLARE_API_TOKEN;
  if (!cloudflare) {
    try {
      const config = await readFile(join(homedir(), '.config/.wrangler/config/default.toml'), 'utf8');
      cloudflare = config.match(/^oauth_token\s*=\s*"([^"\n]+)"/m)?.[1];
      const expiry = config.match(/^expiration_time\s*=\s*"([^"\n]+)"/m)?.[1];
      if (expiry && new Date(expiry) <= new Date()) cloudflare = null;
    } catch { /* Une variable d'environnement peut remplacer la connexion Wrangler. */ }
  }
  if (!cloudflare) throw new Error('Connexion Cloudflare requise. Exécute npx wrangler login, puis relance npm run deploy.');
  secrets.push(github, cloudflare); return { github, cloudflare };
}
async function api(provider, path, method = 'GET', body, allow404 = false) {
  const github = provider === 'github';
  const headers = { Authorization: `Bearer ${auth[provider]}`, ...(github ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : {}) };
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const response = await fetch(`${github ? 'https://api.github.com' : 'https://api.cloudflare.com/client/v4'}${path}`, { method, headers, body, signal: AbortSignal.timeout(60000) });
  if (allow404 && response.status === 404) return null;
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok || (!github && result?.success === false)) throw new Error(`${github ? 'GitHub' : 'Cloudflare'} a refusé l'opération (${response.status}). Vérifie les droits du compte avant de relancer.`);
  return github ? result : result?.result;
}
async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Un lien symbolique se trouve dans les fichiers publics.');
    if (entry.isDirectory()) files.push(...await filesUnder(path)); else if (entry.isFile()) files.push(path);
  }
  return files;
}
async function audit(files) {
  const report = [];
  for (const file of files) {
    const body = await readFile(file), text = body.toString('utf8');
    if (secrets.some((value) => value && body.includes(Buffer.from(value))) || /gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/.test(text)) throw new Error('Publication bloquée : un code privé ou un secret probable se trouve dans les fichiers publics.');
    if (relative(root, file).split(sep).includes('.private')) throw new Error('Publication bloquée : présence de données privées.');
    report.push({ path: relative(root, file), bytes: body.length });
  }
  await writeFile(join(privateDir, 'publication-audit.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function git(args, extra = {}) {
  const identity = `${user.id}+${user.login}@users.noreply.github.com`;
  return run('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: user.login, GIT_AUTHOR_EMAIL: identity, GIT_COMMITTER_NAME: user.login, GIT_COMMITTER_EMAIL: identity, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.github}`).toString('base64')}`, ...extra } });
}
async function publishGit(sourceFiles, dist) {
  const remote = `https://github.com/${user.login}/${repo}.git`;
  let currentRemote = '';
  try { currentRemote = (await git(['remote', 'get-url', 'origin'])).stdout.trim(); } catch { /* Dépôt neuf. */ }
  if (currentRemote && currentRemote !== remote) throw new Error('Le dépôt local possède une autre origine. Aucun dépôt existant ne sera remplacé.');
  if (!currentRemote) await git(['remote', 'add', 'origin', remote]);
  const staged = (await git(['diff', '--cached', '--name-only'])).stdout.split('\n').filter(Boolean);
  const allowed = new Set(sourceFiles.map((path) => relative(root, path)));
  if (staged.some((path) => !allowed.has(path))) throw new Error('Des fichiers hors publication sont déjà indexés. Vérifie l\'index Git avant de relancer.');
  await git(['add', '--', ...allowed]);
  let changes = false;
  try { await git(['diff', '--cached', '--quiet']); } catch (error) { if (error.code !== 1) throw error; changes = true; }
  if (changes) await git(['commit', '-m', 'feat: Ajouter le carnet partagé']);
  await git(['push', 'origin', 'HEAD:refs/heads/main']);
  const sourceSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  if ((await git(['ls-remote', 'origin', 'refs/heads/main'])).stdout.split(/\s/)[0] !== sourceSha) throw new Error('La branche source a changé pendant la publication. Vérifie GitHub avant de relancer.');
  const index = join(privateDir, `pages-index-${randomUUID()}`), extra = { GIT_INDEX_FILE: index };
  let previous;
  const remoteHead = (await git(['ls-remote', 'origin', 'refs/heads/gh-pages'])).stdout.trim().split(/\s/)[0];
  if (remoteHead) { await git(['fetch', 'origin', 'refs/heads/gh-pages']); previous = (await git(['rev-parse', 'FETCH_HEAD'])).stdout.trim(); }
  try {
    await git(['read-tree', '--empty'], extra);
    await git(['-C', dist, '--git-dir', join(root, '.git'), '--work-tree', dist, 'add', '--all'], extra);
    const tree = (await git(['write-tree'], extra)).stdout.trim();
    const pagesSha = (await git(['commit-tree', tree, ...(previous ? ['-p', previous] : []), '-m', 'build: Publier le carnet'])).stdout.trim();
    await git(['push', 'origin', `${pagesSha}:refs/heads/gh-pages`]);
    const verified = (await git(['ls-remote', 'origin', 'refs/heads/gh-pages'])).stdout.split(/\s/)[0];
    if (verified !== pagesSha) throw new Error('La branche publiée a changé. Vérifie GitHub avant de relancer.');
    progress.sourceSha = sourceSha; progress.pagesSha = pagesSha; await remember();
  } finally { await rm(index, { force: true }); }
}

try {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(repo)) throw new Error('Nom de dépôt invalide.');
  await mkdir(privateDir, { recursive: true, mode: 0o700 }); auth = await credentials();
  user = await api('github', '/user');
  const accounts = await api('cloudflare', '/accounts');
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : null);
  if (!account || !accounts.some((item) => item.id === account)) throw new Error('Choisis CLOUDFLARE_ACCOUNT_ID parmi tes comptes avant de publier.');
  const prefix = `/accounts/${account}`, subdomain = await api('cloudflare', `${prefix}/workers/subdomain`);
  if (!subdomain?.subdomain) throw new Error('Active le sous-domaine workers.dev dans Cloudflare avant la publication.');
  if (process.argv.includes('--check')) { console.log('Accès GitHub et Cloudflare vérifiés. Aucune ressource créée.'); process.exit(0); }
  const origin = `https://${user.login.toLowerCase()}.github.io`, endpoint = `https://${workerName}.${subdomain.subdomain}.workers.dev/api/trip`;
  console.log('Vérification des tests et des fichiers publics...');
  const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith('.test.mjs')).map((name) => join(root, 'tests', name));
  await run(process.execPath, ['--test', ...tests], { cwd: root });
  const dist = await build(endpoint), initial = await saved(join(privateDir, 'initial.json'), null); if (initial) validateData(initial);
  progress = await saved(statePath, { owner: user.login, repo, account });
  if (progress.owner !== user.login || progress.repo !== repo || progress.account !== account) throw new Error('Ce dossier correspond à une autre publication. Aucun compte ou dépôt existant ne sera modifié.');
  let code;
  try { code = (await readFile(join(privateDir, 'shared-code'), 'utf8')).trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; if (progress.workerCreated) throw new Error('Le code partagé local est absent. Restaure .private/shared-code avant de republier ; aucune rotation automatique ne sera faite.'); code = randomBytes(32).toString('base64url'); await writeFile(join(privateDir, 'shared-code'), code, { mode: 0o600 }); }
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Le code partagé local est invalide.'); secrets.push(code);
  const sourceFiles = [];
  for (const folder of ['public', 'worker', 'tools', 'tests']) sourceFiles.push(...await filesUnder(join(root, folder)));
  for (const file of ['package.json', '.gitignore', 'README.md']) sourceFiles.push(join(root, file));
  await audit([...sourceFiles, ...await filesUnder(dist)]);
  let repository = await api('github', `/repos/${user.login}/${repo}`, 'GET', undefined, true);
  if (repository && !progress.repositoryCreated) throw new Error('Ce dépôt existe déjà. Utilise GITHUB_REPO pour choisir un nom libre.');
  const existingWorker = await api('cloudflare', `${prefix}/workers/scripts/${workerName}/settings`, 'GET', undefined, true);
  if (existingWorker && !progress.workerCreated) throw new Error('Un service du même nom existe déjà. Il ne sera pas remplacé.');
  console.log('Préparation du stockage privé...');
  if (!progress.databaseId) {
    const databases = await api('cloudflare', `${prefix}/d1/database`);
    if (databases.some((item) => item.name === 'carnet-a-deux')) throw new Error('Une base du même nom existe déjà. Son contenu ne sera pas modifié.');
    const created = await api('cloudflare', `${prefix}/d1/database`, 'POST', { name: 'carnet-a-deux' });
    progress.databaseId = created.uuid; await remember();
  }
  await api('cloudflare', `${prefix}/d1/database/${progress.databaseId}/query`, 'POST', { sql: await readFile(join(root, 'worker/migration.sql'), 'utf8') });
  console.log('Publication du service partagé...');
  const upload = new FormData();
  upload.set('metadata', new Blob([JSON.stringify({ main_module: 'worker/index.js', compatibility_date: '2026-09-01', bindings: [{ type: 'd1', name: 'DB', id: progress.databaseId }, { type: 'secret_text', name: 'EDIT_TOKEN', text: code }, { type: 'plain_text', name: 'ALLOWED_ORIGIN', text: origin }] })], { type: 'application/json' }));
  for (const file of ['worker/index.js', 'public/schema.js']) upload.set(file, new File([await readFile(join(root, file))], file, { type: 'application/javascript+module' }));
  await api('cloudflare', `${prefix}/workers/scripts/${workerName}`, 'PUT', upload); progress.workerCreated = true; await remember();
  await api('cloudflare', `${prefix}/workers/scripts/${workerName}/subdomain`, 'POST', { enabled: true, previews_enabled: false });
  const headers = { Authorization: `Bearer ${code}`, 'Content-Type': 'application/json' };
  const current = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
  if (!current.ok) throw new Error('Le service déployé ne répond pas encore. Relance la publication pour reprendre.');
  const snapshot = await current.json();
  if (snapshot.revision === 0 && initial) {
    const response = await fetch(endpoint, { method: 'PUT', headers, body: JSON.stringify({ revision: 0, writeId: randomUUID(), data: initial }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Les données de départ ne sont pas encore confirmées en ligne. Relance la publication.');
  }
  const verified = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
  if (!verified.ok || (initial && (await verified.json()).revision < 1)) throw new Error('La lecture de contrôle du carnet a échoué.');
  if (!repository) { repository = await api('github', '/user/repos', 'POST', { name: repo, private: false, auto_init: false, description: 'Un carnet de voyage partagé. Code public, données privées.' }); progress.repositoryCreated = true; await remember(); }
  console.log('Publication du code et du site sur GitHub...');
  await publishGit(sourceFiles, dist);
  const pagesPath = `/repos/${user.login}/${repo}/pages`;
  let pages = await api('github', pagesPath, 'GET', undefined, true);
  if (!pages) pages = await api('github', pagesPath, 'POST', { source: { branch: 'gh-pages', path: '/' }, build_type: 'legacy' });
  if (pages.source?.branch !== 'gh-pages' || pages.source?.path !== '/') throw new Error('La source GitHub Pages diffère de cette publication. Vérifie les réglages avant de continuer.');
  progress.siteUrl = pages.html_url; await remember();
  await writeFile(join(privateDir, 'invitation.txt'), `${pages.html_url}#code=${encodeURIComponent(code)}\n`, { mode: 0o600 });
  console.log('Attente de la construction GitHub Pages...');
  let built = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await api('github', `${pagesPath}/builds/latest`, 'GET', undefined, true);
    if (status?.commit === progress.pagesSha && status.status === 'built') { built = true; break; }
    if (status?.commit === progress.pagesSha && status.status === 'errored') throw new Error('La construction GitHub Pages a échoué. Le dépôt et le carnet sont conservés.');
    await new Promise((done) => setTimeout(done, 10000));
  }
  if (!built) throw new Error('GitHub Pages travaille encore. Relance la publication pour vérifier la suite.');
  const live = await fetch(new URL('config.js', pages.html_url), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!live.ok || !(await live.text()).includes(endpoint)) throw new Error('La version publiée n\'est pas encore confirmée par sa lecture.');
  if (process.argv.includes('--enrich')) {
    console.log('Ajout des contenus privés préparés...');
    const result = await applyEnrichment({ endpoint, token: code, privateDir });
    console.log(result.status === 'already-applied' ? 'Ces contenus ont déjà été ajoutés. Les choix actuels sont conservés.' : 'Contenus privés ajoutés et relus.');
  }
  console.log(`Site publié et contrôlé : ${pages.html_url}\nDépôt : ${repository.html_url}\nLien d'invitation privé : .private/invitation.txt`);
} catch (error) {
  let message = error.message;
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[code masqué]');
  console.error(message); process.exitCode = 1;
}
