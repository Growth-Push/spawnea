import { describe, it, expect } from 'vitest';
import { detectOutputArtifacts, stripPathLineNumber, validateExternalArtifactContent } from '../src/output-artifact-detector.js';

describe('OutputArtifactDetector', () => {
  const worktreePath = '/workspace/spawnea';

  it('detects Antigravity / Gemini CLI Create tool call', () => {
    const output = `
      ▄▀▀▄        Antigravity CLI 1.1.19
     ▀▀▀▀▀▀       developer@example.com (Google AI Pro)
    ▀▀▀▀▀▀▀▀      Gemini 3.7 Flash (High)
   ▄▀▀    ▀▀▄     /workspace/spawnea
  ▄▀▀      ▀▀▄

────────────────────────────────────────────────────────────
> can you create a file \`TO_DELETE_README.md\` ?

▸ Thought for 7s, 226 tokens
  Initiating File Creation

● Create(/workspace/spawnea/TO_DELETE_README.md) (ctrl+o to expand)
`;

    const results = detectOutputArtifacts(output, { worktreePath, harness: 'antigravity' });

    expect(results.length).toBeGreaterThan(0);
    const item = results.find((r) => r.filename === 'TO_DELETE_README.md');
    expect(item).toBeDefined();
    expect(item?.normalizedPath).toBe('/workspace/spawnea/TO_DELETE_README.md');
    expect(item?.source).toBe('tool_call');
    expect(item?.confidence).toBeGreaterThan(0.9);
  });

  it('detects Antigravity Edit tool call with relative path', () => {
    const output = `● Edit(apps/desktop/src/App.tsx) (ctrl+o to expand)`;
    const results = detectOutputArtifacts(output, { worktreePath });

    const item = results.find((r) => r.filename === 'App.tsx');
    expect(item).toBeDefined();
    expect(item?.normalizedPath).toBe('/workspace/spawnea/apps/desktop/src/App.tsx');
  });

  it('detects Claude Code file creation and modification phrases', () => {
    const output = `
I have created the architecture plan for the project:
Created file docs/architecture-plan.md
Wrote tests/suite.test.ts
Saved to output/diagram.png
`;

    const results = detectOutputArtifacts(output, { worktreePath, harness: 'claude' });

    expect(results.some((r) => r.filename === 'architecture-plan.md')).toBe(true);
    expect(results.some((r) => r.filename === 'suite.test.ts')).toBe(true);
    expect(results.some((r) => r.filename === 'diagram.png')).toBe(true);
  });

  it('detects Codex and OpenCode output phrases', () => {
    const output = `Applied edit to /workspace/spawnea/packages/domain/src/index.ts`;
    const results = detectOutputArtifacts(output, { worktreePath, harness: 'codex' });

    expect(results.some((r) => r.filename === 'index.ts')).toBe(true);
  });

  it('filters out node_modules, .git, and invalid tokens', () => {
    const output = `
Loading node_modules/react/index.js
Inspecting .git/HEAD
Checking version v1.2.3 and https://example.com/file.png
`;

    const results = detectOutputArtifacts(output, { worktreePath });

    expect(results.some((r) => r.path.includes('node_modules'))).toBe(false);
    expect(results.some((r) => r.path.includes('.git/'))).toBe(false);
    expect(results.some((r) => r.path.startsWith('http'))).toBe(false);
    expect(results.some((r) => r.filename === 'v1.2.3')).toBe(false);
  });

  it('filters out default blacklisted files like package-lock.json and *.log', () => {
    const output = `
Created file package-lock.json
Wrote debug.log
Created pnpm-lock.yaml
Created notes.txt
`;
    const results = detectOutputArtifacts(output, { worktreePath });

    expect(results.some((r) => r.filename === 'package-lock.json')).toBe(false);
    expect(results.some((r) => r.filename === 'debug.log')).toBe(false);
    expect(results.some((r) => r.filename === 'pnpm-lock.yaml')).toBe(false);
    expect(results.some((r) => r.filename === 'notes.txt')).toBe(true);
  });

  it('supports custom blacklist patterns via options', () => {
    const output = `
Created custom-report.pdf
Created generated-schema.json
`;
    const results = detectOutputArtifacts(output, {
      worktreePath,
      blacklistPatterns: ['*.pdf', 'generated-schema.json'],
    });

    expect(results.some((r) => r.filename === 'custom-report.pdf')).toBe(false);
    expect(results.some((r) => r.filename === 'generated-schema.json')).toBe(false);
  });

  it('rejects relative traversal and prefix collisions but keeps allowed external absolute paths', () => {
    const output = `
Created file /tmp/external-report.md
Created file ../outside-report.md
Created file /workspace/spawnea-extra/report.md
Created file /workspace/spawnea/docs/../safe-report.md
Created file /tmp/tool.sh
Created file /tmp/drawing.svg
`;

    const results = detectOutputArtifacts(output, { worktreePath });

    expect(results.map((result) => [result.normalizedPath, result.external])).toEqual([
      ['/tmp/external-report.md', true],
      ['/workspace/spawnea-extra/report.md', true],
      ['/workspace/spawnea/safe-report.md', false],
    ]);
  });

  const demoHome = ['', 'home', 'demo_usr'].join('/');

  it('resolves ~/ against the supplied host home and ignores it without one', () => {
    const output = 'Wrote ~/.config/demo/settings.yaml and ~/pics/shot.png';
    expect(detectOutputArtifacts(output, { worktreePath })).toEqual([]);

    const results = detectOutputArtifacts(output, { worktreePath, homeDir: `${demoHome}/` });
    expect(results.map((result) => [result.normalizedPath, result.external])).toEqual([
      [`${demoHome}/.config/demo/settings.yaml`, true],
      [`${demoHome}/pics/shot.png`, true],
    ]);
  });

  it('detects full, home-relative, relative, and bare file paths with line numbers', () => {
    const output = `
Created file /workspace/spawnea/artifact-demo.md
Open ./docs/guide.adoc and docs/notes.rst:12:3
artifact-demo.md
`;

    const results = detectOutputArtifacts(output, { worktreePath });

    expect(results.map((result) => result.normalizedPath)).toEqual([
      '/workspace/spawnea/artifact-demo.md',
      '/workspace/spawnea/docs/guide.adoc',
      '/workspace/spawnea/docs/notes.rst',
    ]);
    expect(stripPathLineNumber('notes.rst:12:3')).toBe('notes.rst');

    const homeRoot = ['', 'home', 'demo_usr', 'demo-proj'].join('/');
    const homeResults = detectOutputArtifacts('See ~/demo-proj/relative-report.pdf:8', {
      worktreePath: homeRoot,
      homeDir: ['', 'home', 'demo_usr'].join('/'),
    });
    expect(homeResults[0]?.normalizedPath).toBe(`${homeRoot}/relative-report.pdf`);

    const windowsRoot = ['C:', 'users', 'demo', 'demo-proj'].join('\\');
    const windowsResults = detectOutputArtifacts('Created C:\\UsErS\\demo\\demo-proj\\artifact.bin:8', {
      worktreePath: windowsRoot,
    });
    expect(windowsResults[0]?.normalizedPath).toBe('C:/UsErS/demo/demo-proj/artifact.bin');

    const windowsHomeResults = detectOutputArtifacts('See ~\\demo-proj\\relative-report.pdf:8', {
      worktreePath: windowsRoot,
      homeDir: 'C:/users/demo',
    });
    expect(windowsHomeResults[0]?.normalizedPath).toBe('C:/users/demo/demo-proj/relative-report.pdf');
  });

  it('detects the shell transcript form that reports a created absolute path', () => {
    const output = `printf '# Demo artifact\\n' > artifact-demo.md
printf 'Created file /workspace/spawnea/artifact-demo.md\\n'
Created file /workspace/spawnea/artifact-demo.md`;

    const results = detectOutputArtifacts(output, { worktreePath });

    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('artifact-demo.md');
    expect(results[0].normalizedPath).toBe('/workspace/spawnea/artifact-demo.md');
  });

  it('detects paths wrapped in arbitrary delimiters, quotes, parentheses, brackets, or arrows (e.g. Hermes paste)', () => {
    const output = `
Welcome to Hermes Agent! Type your message or /help for commands.
────────────────────────────────────────
● [Pasted text #1: 28 lines → /workspace/spawnea/pastes/paste_1_095410.txt
Initializing agent...
────────────────────────────────────────

Other matches:
"(/workspace/spawnea/apps/desktop/src/main/session-supervisor.ts)
"d(/workspace/spawnea/apps/desktop/src/main/session-supervisor.ts
"/workspace/spawnea/apps/desktop/src/main/session-supervisor.ts"
[/workspace/spawnea/notes.md]
</workspace/spawnea/config.json>
/workspace/spawnea/foo+bar.pdf
/workspace/spawnea/git@build-report.txt
/workspace/spawnea/_private-notes.md
/workspace/spawnea/trailing-colon.md: complete
/workspace/spawnea/first-list.md,/workspace/spawnea/second-list.md;/workspace/spawnea/third-list.md!/workspace/spawnea/fourth-list.md?
`;

    const results = detectOutputArtifacts(output, { worktreePath });

    const paths = results.map((r) => r.normalizedPath);
    expect(paths).toContain('/workspace/spawnea/pastes/paste_1_095410.txt');
    expect(paths).toContain('/workspace/spawnea/apps/desktop/src/main/session-supervisor.ts');
    expect(paths).toContain('/workspace/spawnea/notes.md');
    expect(paths).toContain('/workspace/spawnea/config.json');
    expect(paths).toContain('/workspace/spawnea/foo+bar.pdf');
    expect(paths).toContain('/workspace/spawnea/git@build-report.txt');
    expect(paths).toContain('/workspace/spawnea/_private-notes.md');
    expect(paths).toContain('/workspace/spawnea/trailing-colon.md');
    expect(paths).toContain('/workspace/spawnea/first-list.md');
    expect(paths).toContain('/workspace/spawnea/second-list.md');
    expect(paths).toContain('/workspace/spawnea/third-list.md');
    expect(paths).toContain('/workspace/spawnea/fourth-list.md');
    // Ensure that foo+bar.pdf is NOT split into bar.pdf
    expect(paths).not.toContain('/workspace/spawnea/bar.pdf');

    // Verify deduplication
    const supervisorMatches = results.filter(
      (r) => r.normalizedPath === '/workspace/spawnea/apps/desktop/src/main/session-supervisor.ts'
    );
    expect(supervisorMatches).toHaveLength(1);
  });
});

describe('validateExternalArtifactContent', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  it('requires a matching signature for images and PDFs', () => {
    expect(validateExternalArtifactContent('a.png', png)).toBe(true);
    expect(validateExternalArtifactContent('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(validateExternalArtifactContent('a.gif', Buffer.from('GIF89a....'))).toBe(true);
    expect(validateExternalArtifactContent('a.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(validateExternalArtifactContent('a.pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(validateExternalArtifactContent('a.jpg', png)).toBe(false);
    expect(validateExternalArtifactContent('a.pdf', Buffer.from('plain text'))).toBe(false);
  });

  it('accepts UTF-8 text, tolerates a cut multi-byte tail, and rejects binary or unsupported types', () => {
    expect(validateExternalArtifactContent('a.yaml', Buffer.from('key: ñ\n'))).toBe(true);
    expect(validateExternalArtifactContent('a.txt', Buffer.from('ñ').subarray(0, 1))).toBe(true);
    expect(validateExternalArtifactContent('a.json', Buffer.from([0x7b, 0x00]))).toBe(false);
    expect(validateExternalArtifactContent('a.txt', Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    expect(validateExternalArtifactContent('a.svg', Buffer.from('<svg/>'))).toBe(false);
    expect(validateExternalArtifactContent('a.sh', Buffer.from('echo'))).toBe(false);
    expect(validateExternalArtifactContent('a.txt', Buffer.alloc(0))).toBe(false);
  });
});
