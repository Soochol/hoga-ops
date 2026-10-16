export function packageVersion(source) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(source)) throw new Error('VERSION must have four numeric parts');
  const [major, minor, patch, revision] = source.split('.').map(Number);
  if (![major, minor, patch, revision].every(Number.isSafeInteger)) throw new Error('Invalid VERSION');
  return `${major}.${minor}.${patch}-rev.${revision}`;
}
