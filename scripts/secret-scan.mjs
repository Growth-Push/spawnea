import { spawnSync } from 'node:child_process';

const expectedVersion = '8.30.1';
const version = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });

if (version.error) {
  console.error(`Gitleaks ${expectedVersion} is required. Install it from https://github.com/gitleaks/gitleaks/releases.`);
  process.exit(1);
}

const versionOutput = `${version.stdout || ''}${version.stderr || ''}`;
if (version.status !== 0 || !versionOutput.includes(expectedVersion)) {
  console.error(`Gitleaks ${expectedVersion} is required; detected: ${versionOutput.trim() || 'unknown version'}`);
  process.exit(1);
}

const result = spawnSync(
  'gitleaks',
  ['detect', '--source', '.', '--no-banner', '--redact', '--exit-code', '1'],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);