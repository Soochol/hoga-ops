import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const folder = resolve('out/make/deb/x64');
const files = (await readdir(folder)).filter(name => name.startsWith('ticklane_') && name.endsWith('.deb'));
if (files.length !== 1) throw new Error('Build exactly one .deb using npm run make first');
const temporary = await mkdtemp(join(tmpdir(), 'hoga-deb-verify-'));
try {
  execFileSync('dpkg-deb', ['--extract', join(folder, files[0]), temporary], { stdio: 'inherit' });
  const binary = join(temporary, 'usr/lib/ticklane/ticklane');
  execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
    stdio: 'inherit', env: { ...process.env, HOGA_DESKTOP_EXECUTABLE: binary },
  });
} finally { await rm(temporary, { recursive: true, force: true }); }
