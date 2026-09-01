#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const outputPath = resolve(root, 'apps/desktop/build/THIRD-PARTY-NOTICES.txt');
const licenseNames = [
  'LICENSE',
  'LICENSE.txt',
  'LICENSE.md',
  'LICENSE-MIT',
  'UNLICENSE',
  'COPYING',
  'NOTICE',
];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readLicenseText(packagePath) {
  const entries = await readdir(packagePath, { withFileTypes: true });
  const files = new Map(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name.toLowerCase(), entry.name]),
  );

  for (const preferredName of licenseNames) {
    const actualName = files.get(preferredName.toLowerCase());
    if (!actualName) continue;
    return {
      filename: actualName,
      text: (await readFile(resolve(packagePath, actualName), 'utf8')).trim(),
    };
  }

  const fallbackName = [...files.values()]
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(name))
    .sort(compareText)[0];
  if (!fallbackName) return undefined;
  return {
    filename: fallbackName,
    text: (await readFile(resolve(packagePath, fallbackName), 'utf8')).trim(),
  };
}

async function loadProductionPackages() {
  const { stdout } = await execFileAsync('pnpm', ['licenses', 'list', '--prod', '--json'], {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  if (report.error) throw new Error(report.error.message ?? 'pnpm license metadata failed');

  const packages = new Map();
  for (const entries of Object.values(report)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const packagePath of entry.paths ?? []) {
        const manifest = JSON.parse(await readFile(resolve(packagePath, 'package.json'), 'utf8'));
        const name = manifest.name ?? entry.name;
        const version = manifest.version;
        if (!name || !version) {
          throw new Error(`Incomplete package metadata at ${basename(packagePath)}`);
        }

        const key = `${name}@${version}`;
        if (packages.has(key)) continue;
        packages.set(key, {
          key,
          name,
          version,
          license: entry.license ?? manifest.license ?? 'Unknown',
          homepage: entry.homepage ?? manifest.homepage,
          licenseFile: await readLicenseText(packagePath),
        });
      }
    }
  }

  return [...packages.values()].sort((left, right) => compareText(left.key, right.key));
}

function formatNotices(packages) {
  const sections = [
    'SPAWNEA THIRD-PARTY NOTICES',
    '',
    'This file is generated from the locked pnpm production dependency graph.',
    'It does not replace Spawnea\'s own Apache-2.0 LICENSE.',
    '',
  ];

  for (const pkg of packages) {
    sections.push('='.repeat(78));
    sections.push(pkg.key);
    sections.push(`Declared license: ${pkg.license}`);
    if (pkg.homepage) sections.push(`Project: ${pkg.homepage}`);
    sections.push('');
    if (pkg.licenseFile?.text) {
      sections.push(`License text from ${pkg.licenseFile.filename}:`);
      sections.push('');
      sections.push(pkg.licenseFile.text.replaceAll('\r\n', '\n'));
    } else {
      sections.push('The installed package contains no standalone license file.');
      sections.push(`Refer to the package's declared ${pkg.license} license.`);
    }
    sections.push('');
  }

  return `${sections.join('\n').trimEnd()}\n`;
}

try {
  const packages = await loadProductionPackages();
  for (const requiredName of ['react', 'zod', 'yaml']) {
    if (!packages.some((pkg) => pkg.name === requiredName)) {
      throw new Error(`Expected bundled dependency is missing from notices: ${requiredName}`);
    }
  }
  if (packages.length === 0) throw new Error('No production dependencies were found');

  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, formatNotices(packages), 'utf8');
  console.log(`Generated ${outputPath} with ${packages.length} package notices.`);
} catch (error) {
  console.error(`Third-party notice generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
