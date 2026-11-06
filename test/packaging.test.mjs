import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const exec = promisify(execFile);
const documents = ['README.md', 'README.ko.md', 'LICENSE', 'CHANGELOG.md', '.env.example', 'mcp.example.json'];

test('public package has a versioned executable and repository metadata', async () => {
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.bin, { 'cloudroom-mcp': 'server.mjs' });
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.equal(manifest.repository.url, 'git+https://github.com/hyein-cbio/cloudroom-mcp.git');
  assert.equal(manifest.engines.node, '>=22');
  assert((await readFile(join(root, 'server.mjs'), 'utf8')).startsWith('#!/usr/bin/env node\n'));
  const sample = JSON.parse(await readFile(join(root, 'mcp.example.json'), 'utf8'));
  assert.equal(sample.mcpServers.room.command, 'npx');
  assert.deepEqual(sample.mcpServers.room.args, ['--yes', 'cloudroom-mcp@' + manifest.version]);
  for (const path of ['package-lock.json', 'README.md', 'README.ko.md']) {
    const text = await readFile(join(root, path), 'utf8');
    if (path.endsWith('.json')) {
      const lock = JSON.parse(text);
      assert.equal(lock.version, manifest.version);
      assert.equal(lock.packages[''].version, manifest.version);
    } else assert(text.includes('cloudroom-mcp@' + manifest.version));
  }
});

test('npm pack includes only runtime and public docs, never local indexes or credentials', { timeout: 30_000 }, async t => {
  const stage = await mkdtemp(join(tmpdir(), 'cloudroom-pack-test-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const sources = (await readdir(join(root, 'src'))).filter(path => path.endsWith('.mjs')).map(path => 'src/' + path);
  const expected = ['package.json', 'server.mjs', ...sources, ...documents].sort();
  for (const path of expected) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await cp(join(root, path), join(stage, path));
  }
  // A global Git ignore does not protect npm tarballs. Exercise the files allowlist
  // with private-looking files even on clean CI machines with no local index.
  for (const path of ['.cocoindex_code/private.db', '.env', '.npmrc', 'test/private.mjs', 'ci/private.py', 'src/private.txt']) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), path === '.npmrc' ? '# test sentinel\n' : 'DO NOT PUBLISH\n');
  }
  assert(process.env.npm_execpath, 'Run packaging regression tests through npm test');
  const { stdout } = await exec(process.execPath, [process.env.npm_execpath,
    'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', join(stage, 'npm-cache')], {
    cwd: stage, timeout: 25_000, maxBuffer: 1_048_576,
  });
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.version, manifest.version);
  assert.deepEqual(packed.files.map(file => file.path).sort(), expected);
  assert(packed.unpackedSize < 250_000, 'Unexpected package growth: inspect the published file list');
});
