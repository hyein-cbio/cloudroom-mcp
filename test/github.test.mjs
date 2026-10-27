import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGithubRegistration, GITHUB_REGISTRATION_PATH, repositoryFromRemote } from '../src/github.mjs';
import { tempConfig } from './helpers.mjs';

test('stored GitHub remotes are normalized without treating arbitrary URLs or paths as repositories', () => {
  for (const value of ['https://github.com/Owner/Test.git', 'https://github.com/owner/test', 'git@github.com:owner/test.git']) {
    assert.equal(repositoryFromRemote(value), 'owner/test');
  }
  for (const value of [null, '/local/repo', 'https://evil.test/owner/test.git', 'https://github.com.evil.test/owner/test.git',
    'https://github.com/owner/test.git?token=secret', 'https://user:secret@github.com/owner/test.git',
    'https://github.com:8443/owner/test.git', 'http://github.com/owner/test', 'https://github.com/owner/test/tree/main']) {
    assert.equal(repositoryFromRemote(value), null, String(value));
  }
});

test('registration uses one bounded loopback JSON POST with no cookies or redirects', async t => {
  const config = await tempConfig(t);
  let calls = 0;
  const register = createGithubRegistration(config, async (url, options) => {
    calls++;
    assert.equal(url, config.serverUrl + GITHUB_REGISTRATION_PATH);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { repo: 'owner/test' });
    return Response.json({ projectId: 'proj_new' });
  });
  assert.equal(await register('Owner/Test'), 'proj_new');
  assert.equal(calls, 1);
});

test('HTTP failures and malformed success responses never retry or silently fall back', async t => {
  const config = await tempConfig(t);
  for (const response of [
    new Response('forbidden', { status: 403 }),
    new Response('not json'),
    Response.json({}),
    Response.json({ projectId: 'proj_personal' }),
    Response.json({ projectId: '../../path' }),
  ]) {
    let calls = 0;
    const register = createGithubRegistration(config, async () => { calls++; return response; });
    await assert.rejects(register('owner/test'), error =>
      error.details.outcome_unknown === true && error.details.phase === 'repository_registration');
    assert.equal(calls, 1);
  }
});

test('oversized registration output is bounded and reported as an uncertain mutation', async t => {
  const register = createGithubRegistration(await tempConfig(t), async () => new Response('x'.repeat(70_000)));
  await assert.rejects(register('owner/test'), error =>
    error.code === 'github_response_limit' && error.details.outcome_unknown === true);
});

test('registration cancellation and deadlines do not cause hidden retries', async t => {
  const config = await tempConfig(t, { CLOUDROOM_TIMEOUT_MS: '100' });
  let calls = 0;
  const register = createGithubRegistration(config, async (_url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Unexpected long wait')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  });
  await assert.rejects(register('owner/test', { signal: AbortSignal.abort() }), error =>
    error.code === 'cancelled' && error.details.outcome_unknown === false);
  assert.equal(calls, 0);
  await assert.rejects(register('owner/test'), error =>
    error.code === 'timeout' && error.details.outcome_unknown === true);
  assert.equal(calls, 1);
});

test('real fetch refuses to follow even a loopback redirect from the registration endpoint', async t => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === GITHUB_REGISTRATION_PATH) {
      res.writeHead(302, { Location: '/should-not-be-called' });
      res.end();
    } else { redirected++; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const config = await tempConfig(t, { CLOUDROOM_SERVER_URL: 'http://127.0.0.1:' + server.address().port });
  await assert.rejects(createGithubRegistration(config)('owner/test'), { code: 'github_registration_failed' });
  assert.equal(redirected, 0);
});
