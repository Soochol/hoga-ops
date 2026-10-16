import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageVersion } from './version.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const sourceVersion = (await readFile('../VERSION', 'utf8')).trim();
const version = packageVersion(sourceVersion);
// npm lockfile and manifest stay in sync even after the root VERSION changes.
for (const file of ['package.json', 'package-lock.json']) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  await writeFile(file, JSON.stringify(data, null, 2) + '\n');
}
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], { stdio: 'inherit' });
await mkdir('dist', { recursive: true });
await cp('src/preload', 'dist/preload', { recursive: true });
await cp('src/launcher', 'dist/launcher', { recursive: true });
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* source archives */ }
await writeFile('dist/build.json', JSON.stringify({ sourceVersion, version, commit }) + '\n');
