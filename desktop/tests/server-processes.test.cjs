const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { fixture, alive } = require('./helpers/server-fixture.cjs');
const { ServerController } = require('../dist/server/controller');
const { readProcess, sameProcess } = require('../dist/server/processes');

async function ready(f, id) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${f.ports[id]}/health`)).ok) return; } catch { /* starting */ }
    await delay(30);
  }
  throw new Error('Fixture did not start');
}
function controller(f) { return new ServerController(f.settings, join(f.project, 'logs/server.log')); }

test('confirmed external stop terminates only the selected server tree and supports managed restart', async () => {
  const f = await fixture(); const c = controller(f);
  try {
    f.external('backend'); f.external('frontend');
    await Promise.all([ready(f, 'backend'), ready(f, 'frontend')]); await c.refresh();
    const backend = await f.marker('backend'); const frontend = await f.marker('frontend');
    const plan = await c.prepareStop(['backend']);
    assert.deepEqual(plan.blocked, []); assert.equal(plan.targets[0].pid, backend.pid);
    assert.equal(plan.targets[0].cwd, f.project); assert.match(plan.targets[0].user, /\(\d+\)/);
    assert.equal(plan.targets[0].processCount, 2);
    assert.equal(await alive(backend.pid), true); // Preparing/cancelling is read-only.
    const state = await c.confirmStop(plan.token);
    assert.equal(state.services.find(s => s.id === 'backend').phase, 'stopped');
    assert.equal(await alive(backend.pid), false); assert.equal(await alive(backend.worker), false);
    assert.equal(await alive(frontend.pid), true); assert.equal(await alive(frontend.worker), true);
    await assert.rejects(c.confirmStop(plan.token), /만료/);
    await c.start();
    assert.equal(c.snapshot().services.find(s => s.id === 'backend').owner, 'managed');
    assert.equal(c.snapshot().services.find(s => s.id === 'frontend').owner, 'external');
    await c.stop(); assert.equal(await alive(frontend.pid), true);
  } finally { await c.stop(); c.dispose(); await f.dispose(); }
});

test('a port replacement after confirmation preparation is never killed', async () => {
  const f = await fixture(); const c = controller(f);
  try {
    const first = f.external('backend'); await ready(f, 'backend');
    const plan = await c.prepareStop(['backend']);
    const exited = once(first, 'exit'); process.kill(-first.pid, 'SIGTERM'); await exited;
    f.external('backend'); await ready(f, 'backend');
    const replacement = await f.marker('backend');
    await assert.rejects(c.confirmStop(plan.token), /바뀌었습니다/);
    assert.equal(await alive(replacement.pid), true);
    assert.equal(await alive(replacement.worker), true);
  } finally { c.dispose(); await f.dispose(); }
});

test('a matching health response from another checkout is blocked', async () => {
  const f = await fixture(); const other = await fixture(); const c = controller(f);
  try {
    f.external('backend', { cwd: other.project }); await ready(f, 'backend');
    const plan = await c.prepareStop(['backend']);
    assert.equal(plan.targets.length, 0); assert.match(plan.blocked[0].reason, /같은 프로젝트/);
    await assert.rejects(c.confirmStop(plan.token));
    assert.equal(await alive((await f.marker('backend')).pid), true);
  } finally { c.dispose(); await f.dispose(); await other.dispose(); }
});

test('an unrelated listener is blocked while verified targets can still be stopped', async () => {
  const f = await fixture(); const c = controller(f);
  const foreign = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok","version":"fake"}'); });
  await new Promise(done => foreign.listen(f.ports.backend, '127.0.0.1', done));
  try {
    f.external('frontend'); await ready(f, 'frontend');
    const plan = await c.prepareStop();
    assert.deepEqual(plan.targets.map(t => t.id), ['frontend']);
    assert.equal(plan.blocked[0].label, '백엔드');
    await c.confirmStop(plan.token);
    assert.equal(foreign.listening, true);
    assert.equal(await alive((await f.marker('frontend')).pid), false);
  } finally { c.dispose(); await new Promise(done => foreign.close(done)); await f.dispose(); }
});

test('normal stop has a deadline and force stop requires another confirmed plan', { timeout: 20000 }, async () => {
  const f = await fixture(); const c = controller(f);
  try {
    f.external('backend', { env: { TICKLANE_FIXTURE_IGNORE_TERM: 'backend' } }); await ready(f, 'backend');
    const premature = await c.prepareStop(['backend'], true);
    assert.equal(premature.targets.length, 0);
    const normal = await c.prepareStop(['backend']);
    const state = await c.confirmStop(normal.token);
    assert.equal(state.phase, 'error'); assert.match(state.message, /초과/);
    assert.equal(state.services.find(s => s.id === 'backend').canForce, true);
    const marker = await f.marker('backend'); assert.equal(await alive(marker.pid), true);
    const force = await c.prepareStop(['backend'], true);
    assert.equal(force.force, true); assert.equal(await alive(marker.pid), true);
    const stopped = await c.confirmStop(force.token);
    assert.equal(stopped.services.find(s => s.id === 'backend').phase, 'stopped');
    assert.equal(await alive(marker.pid), false); assert.equal(await alive(marker.worker), false);
  } finally { c.dispose(); await f.dispose(); }
});

test('process identity includes startup time, executable, cwd and arguments', async () => {
  const p = await readProcess(process.pid); assert.ok(p);
  assert.equal(sameProcess(p, { ...p }), true);
  for (const update of [{ start: 'other' }, { cwd: '/other' }, { exe: '/other' }, { args: ['other'] }, { uid: -1 }]) {
    assert.equal(sameProcess(p, { ...p, ...update }), false);
  }
});

test('a server bound beyond loopback cannot be stopped through the local manager', async () => {
  const f = await fixture(); const c = controller(f);
  try {
    f.external('backend', { env: { TICKLANE_FIXTURE_HOST: '0.0.0.0' } }); await ready(f, 'backend');
    const plan = await c.prepareStop(['backend']);
    assert.equal(plan.targets.length, 0); assert.match(plan.blocked[0].reason, /루프백 전용/);
    assert.equal(await alive((await f.marker('backend')).pid), true);
  } finally { c.dispose(); await f.dispose(); }
});

test('a reload launcher and its opaque listener child are stopped together', async () => {
  const f = await fixture(); const c = controller(f);
  try {
    const launcher = f.external('backend', { env: { TICKLANE_FIXTURE_RELOAD: 'backend' } }); await ready(f, 'backend');
    const listener = await f.marker('backend');
    const plan = await c.prepareStop(['backend']);
    assert.deepEqual(plan.blocked, []); assert.equal(plan.targets[0].pid, launcher.pid);
    assert.equal(plan.targets[0].processCount, 3);
    await c.confirmStop(plan.token);
    assert.equal(await alive(launcher.pid), false); assert.equal(await alive(listener.pid), false); assert.equal(await alive(listener.worker), false);
  } finally { c.dispose(); await f.dispose(); }
});
