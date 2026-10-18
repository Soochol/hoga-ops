const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { readServerConfig } = require('../dist/server/controller');

test('server manager rejects broken executable paths and port configuration before starting anything', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ticklane-server-config-'));
  const path = join(folder, 'servers.json');
  const valid = { project: folder, uv: '/usr/bin/uv', npm: '/usr/bin/npm', node: '/usr/bin/node' };
  try {
    for (const invalid of [{ ...valid, uv: 'uv' }, { ...valid, project: '/tmp/project\nother' },
      { ...valid, ports: [] }, { ...valid, ports: { backend: 8000, frontend: 8000 } }, { ...valid, ports: { backend: 0 } }]) {
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(readServerConfig(path));
    }
    await writeFile(path, JSON.stringify(valid));
    assert.deepEqual((await readServerConfig(path)).ports, { backend: 8000, frontend: 5173 });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
