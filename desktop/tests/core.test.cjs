const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readdirSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { canonicalOrigin, validateProfile, sessionKey, readSettings, saveSettings, fitBounds } = require('../dist/profiles');
const { appNavigation, networkAllowed, externalLink } = require('../dist/navigation');
const { probeServer } = require('../dist/connection');
const remote = validateProfile({ name: '원격', mode: 'server', origin: 'http://hoga-prod:8000' });

test('rejects credentials, paths, fragments and executable URLs', () => {
  assert.equal(canonicalOrigin(' http://localhost:8000/ '), 'http://localhost:8000');
  for (const url of ['file:///tmp/app', 'javascript:alert(1)', 'http://user:pw@host', 'https://host/live', 'https://host/?x=1', 'https://host/#x']) assert.throws(() => canonicalOrigin(url));
  assert.throws(() => validateProfile({ ...remote, mode: 'development', apiOrigin: 'http://localhost:8000' }, false));
});
test('sessions share an origin, isolate dev and servers, and survive a rename', () => {
  assert.equal(sessionKey(remote), sessionKey({ ...remote, id: 'other', name: 'new' }));
  assert.notEqual(sessionKey(remote), sessionKey({ ...remote, origin: 'http://localhost:8000' }));
  assert.notEqual(sessionKey(remote), sessionKey({ ...remote, mode: 'development', apiOrigin: remote.origin }));
});
test('navigation and request guard prevent remote fallback and malicious child windows', () => {
  assert.ok(appNavigation(`${remote.origin}/live?code=005930&workspaceTransfer=abc`, remote));
  assert.ok(networkAllowed('ws://hoga-prod:8000/api/ws', remote));
  for (const url of ['http://localhost:8000/api/orders', 'ws://localhost:8000/api/ws', 'file:///etc/passwd', 'https://third.example/image']) assert.equal(networkAllowed(url, remote), false);
  assert.equal(appNavigation(`${remote.origin}/api/trading`, remote), false);
  assert.equal(externalLink('file:///tmp/file'), false);
  assert.equal(externalLink('https://u:p@example.com/'), false);
});
test('atomic settings roundtrip and corrupt original preservation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hoga-desktop-core-')); const path = join(dir, 'connections.json');
  try {
    assert.equal(readSettings(path).settings.profiles.length, 0);
    saveSettings(path, { version: 1, profiles: [remote], activeId: remote.id, bounds: {} });
    assert.equal(readSettings(path).settings.activeId, remote.id);
    writeFileSync(path, 'broken');
    assert.match(readSettings(path).warning, /손상/);
    const corrupt = readdirSync(dir).find(name => name.includes('corrupt'));
    assert.equal(readFileSync(join(dir, corrupt), 'utf8'), 'broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('off-screen bounds are restored inside the available monitor', () => {
  assert.deepEqual(fitBounds({ x: 9000, y: -1000, width: 2000, height: 1500 }, [{ x: 0, y: 0, width: 1280, height: 720 }]), { x: 0, y: 0, width: 1280, height: 720 });
});
function request(config = { api_url: '' }, health = { status: 'ok', version: '1', commit: 'abc' }) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    if (url.endsWith('/health')) return Response.json(health);
    if (url.endsWith('/config.json')) return Response.json(config);
    return new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } });
  };
  return { calls, fetcher };
}
test('connection only diagnoses with GET, detects wrong API and missing frontend', async () => {
  const signal = new AbortController().signal;
  const good = request(); assert.equal((await probeServer(remote, signal, good.fetcher)).commit, 'abc');
  assert.equal(good.calls.length, 3);
  await assert.rejects(probeServer(remote, signal, request({ api_url: 'http://localhost:8000' }).fetcher), /API 주소/);
  const dev = { ...remote, mode: 'development', apiOrigin: 'http://localhost:8123' };
  await assert.rejects(probeServer(dev, signal, request({ api_url: '' }).fetcher), /API 주소/);
  assert.equal((await probeServer(dev, signal, request({ api_url: dev.apiOrigin }).fetcher)).version, '1');
  await assert.rejects(probeServer(remote, signal, request({}, { status: 'ok' }).fetcher), /health/);
  await assert.rejects(probeServer(remote, signal, async url => url.endsWith('/live') ? Response.json({}) : request().fetcher(url, { redirect: 'error' })), /프론트/);
});
test('four-part version has ordered, unique semver mapping', async () => {
  const { packageVersion } = await import('../scripts/version.mjs');
  assert.equal(packageVersion('0.16.6.0'), '0.16.6-rev.0');
  assert.equal(packageVersion('0.16.6.1'), '0.16.6-rev.1');
  assert.throws(() => packageVersion('1.2.3'));
});
test('AppArmor permission attaches to one exact executable, without wildcard expansion', async () => {
  const { sandboxProfile } = await import('../scripts/sandbox-profile.mjs');
  const first = sandboxProfile('/home/dev/a [copy]*/electron');
  assert.match(first.policy, /userns,/);
  assert.ok(first.policy.includes('/home/dev/a \\[copy\\]\\*/electron'));
  assert.equal(first.name, sandboxProfile('/home/dev/a [copy]*/electron').name);
  assert.notEqual(first.name, sandboxProfile('/other/electron').name);
  assert.throws(() => sandboxProfile('/tmp/path\nprofile injected'));
  assert.throws(() => sandboxProfile('relative/electron'));
});
