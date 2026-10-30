import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from '../tools/build.mjs';

const root = join(import.meta.dirname, '..');
async function filesUnder(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path)); else files.push(path);
  }
  return files;
}

test('le build ne contient ni carnet privé ni code partagé', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'carnet-build-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const markers = [randomUUID(), randomUUID()];
  await mkdir(join(fixture, 'tools'));
  await mkdir(join(fixture, '.private'));
  await cp(join(root, 'tools/build.mjs'), join(fixture, 'tools/build.mjs'));
  await cp(join(root, 'public'), join(fixture, 'public'), { recursive: true });
  await writeFile(join(fixture, '.private/initial.json'), JSON.stringify({ privateMarker: markers[0] }));
  await writeFile(join(fixture, '.private/shared-code'), markers[1]);
  const { build: fixtureBuild } = await import(pathToFileURL(join(fixture, 'tools/build.mjs')).href);
  const output = await fixtureBuild('https://carnet.example/api/trip'), files = await filesUnder(output);
  const names = files.map((file) => file.slice(output.length));
  assert.ok(names.includes('/index.html')); assert.ok(names.includes('/.nojekyll'));
  assert.equal(names.some((file) => /private|initial\.json|sqlite|invitation|deployment/.test(file)), false);
  const sourceFiles = [];
  for (const folder of ['public', 'worker', 'tools', 'tests']) sourceFiles.push(...await filesUnder(join(root, folder)));
  for (const file of ['package.json', '.gitignore', 'README.md']) sourceFiles.push(join(root, file));
  for (const file of [...files, ...sourceFiles]) {
    const text = (await readFile(file)).toString('utf8');
    assert.equal(markers.some((marker) => text.includes(marker)), false, file);
    assert.equal(/-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----|ghp_[a-zA-Z0-9]{30}/.test(text), false, file);
  }
  assert.equal(await readFile(join(output, 'config.js'), 'utf8'), 'export const API_URL = "https://carnet.example/api/trip";\n');
});
test('le build refuse un protocole dangereux ou un code dans l\'adresse', async () => {
  for (const url of ['http://example.com/api/trip', 'https://user:pass@example.com/api/trip', 'https://example.com/api/trip#code=secret', 'https://example.com/api/trip?code=secret', 'javascript:alert(1)', 'https://example.com/wrong']) await assert.rejects(() => build(url));
});
