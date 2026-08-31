import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set([
  '.git',
  '.pnpm-store',
  '.references',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'references',
  'release',
]);
const ignoredFiles = new Set(['scripts/privacy-check.mjs', '.privacy-denylist']);
const allowedEmailDomains = new Set([
  'example.com',
  'example.invalid',
  'example.test',
]);

const findings = [];

async function loadDenylist() {
  try {
    const content = await readFile(resolve(root, '.privacy-denylist'), 'utf8');
    return content
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith('#'));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(absolutePath));
    else if (entry.isFile()) files.push(absolutePath);
  }
  return files;
}

function addFinding(filePath, lineNumber, message) {
  findings.push(`${filePath}:${lineNumber}: ${message}`);
}

function isAllowedIpv4(address) {
  return address === '127.0.0.1'
    || address.startsWith('192.0.2.')
    || address.startsWith('198.51.100.')
    || address.startsWith('203.0.113.');
}

const denylist = await loadDenylist();
const files = await collectFiles(root);

for (const absolutePath of files) {
  const filePath = relative(root, absolutePath);
  if (
    ignoredFiles.has(filePath)
    || filePath.endsWith('.log')
    || filePath.endsWith('log.txt')
  ) continue;

  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch {
    continue;
  }

  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1;
    if (/\/(?:home|Users)\/[^/\s"']+|\/mnt\/[^/\s"']+/u.test(line)) {
      addFinding(filePath, lineNumber, 'machine-specific absolute path');
    }

    // SVG path coordinates can contain dot-separated decimal sequences that
    // resemble IPv4 addresses. Ignore only path geometry for this check.
    const ipv4ScanLine = line.replace(/\bd="[^"]*"/gu, '');
    for (const match of ipv4ScanLine.matchAll(/\b(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}\b/gu)) {
      const address = match[0];
      if (address.split('.').some((octet) => Number(octet) > 255)) continue;
      if (!isAllowedIpv4(address)) {
        addFinding(filePath, lineNumber, `non-documentation IPv4 address: ${address}`);
      }
    }

    if (/\b[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.(?:internal|lan|home|corp|private)\b/iu.test(line)) {
      addFinding(filePath, lineNumber, 'internal-looking hostname');
    }

    for (const match of line.matchAll(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/giu)) {
      if (match[1].toLowerCase() === 'git') continue;
      if (!allowedEmailDomains.has(match[2].toLowerCase())) {
        addFinding(filePath, lineNumber, `non-example email domain: ${match[2]}`);
      }
    }

    for (const privateValue of denylist) {
      if (line.toLowerCase().includes(privateValue.toLowerCase())) {
        addFinding(filePath, lineNumber, `local denylist match: ${privateValue}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('Privacy check failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Privacy check passed (${files.length} files scanned).`);
}
