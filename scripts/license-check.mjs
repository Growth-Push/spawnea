#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const allowedLicenses = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
]);

let output;
try {
  ({ stdout: output } = await execFileAsync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  }));
} catch (error) {
  console.error('License policy could not read pnpm production license metadata.');
  if (error.stderr) console.error(error.stderr.trim());
  process.exit(1);
}

let report;
try {
  report = JSON.parse(output);
} catch {
  console.error('License policy received invalid JSON from pnpm.');
  process.exit(1);
}

const violations = [];
for (const [rawLicense, packages] of Object.entries(report)) {
  const licenses = rawLicense
    .replaceAll(/[()]/g, '')
    .split(/\s+OR\s+/)
    .map((license) => license.trim());
  if (licenses.some((license) => !allowedLicenses.has(license))) {
    const packageNames = Array.isArray(packages)
      ? packages.map((item) => `${item.name ?? 'unknown'}@${item.version ?? 'unknown'}`).join(', ')
      : 'unknown packages';
    violations.push(`${rawLicense}: ${packageNames}`);
  }
}

if (violations.length > 0) {
  console.error('License policy violations detected:');
  for (const violation of violations.sort()) console.error(`- ${violation}`);
  process.exit(1);
}

const packageCount = Object.values(report)
  .flatMap((packages) => (Array.isArray(packages) ? packages : []))
  .length;
console.log(`License policy passed (${packageCount} production packages scanned).`);
