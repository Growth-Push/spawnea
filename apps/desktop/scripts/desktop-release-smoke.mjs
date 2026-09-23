import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const platform = process.platform;
const root = await mkdtemp(join(tmpdir(), 'spawnea-release-smoke-'));
const appData = join(root, 'user-data');
const runtime = join(root, 'runtime');
const project = join(root, 'project');
const shimDir = join(root, 'bin');
const tmuxTmpDir = join(root, 'tmux');
const controlRuntimeFile = join(runtime, 'control-runtime.json');
const configPath = join(appData, 'config.yaml');
const socketName = `release-smoke-${process.pid}`;
let controlSocketDir;
let controlSocket;
let tmuxBinary;
let appProcess;
let devToolsClient;
let mountedDmg;
let extractedAppImageDir;
let installedDirectory;
let windowsInstallerAttempted = false;
let appExecutable;
let smokeSession;
let artifactRoot;
let mcpHelper;

function logResult(name, status, detail = '') {
  console.log(`RESULT ${name}=${status}${detail ? ` (${detail})` : ''}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', options.captureStdout === false ? 'ignore' : 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
    cwd: options.cwd,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-2_000);
    throw new Error(`${command} exited with ${result.status ?? result.signal}: ${detail}`);
  }
  return result.stdout ?? '';
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

async function withTimeout(promise, description, timeoutMs = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = server.address();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

class DevToolsClient {
  constructor(socketUrl) {
    this.socket = new WebSocket(socketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.closedError = null;
    this.ready = new Promise((resolvePromise, reject) => {
      this.rejectReady = reject;
      this.socket.addEventListener('open', resolvePromise, { once: true });
      this.socket.addEventListener('error', () => this.fail(new Error('Could not connect to Electron DevTools')), { once: true });
      this.socket.addEventListener('close', () => this.fail(new Error('Electron DevTools connection closed')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  fail(error) {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectReady(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async ensureOpen() {
    if (this.closedError) throw this.closedError;
    await this.ready;
    if (this.closedError || this.socket.readyState !== WebSocket.OPEN) {
      throw this.closedError ?? new Error('Electron DevTools connection is not open');
    }
  }

  async send(method, params = {}) {
    await this.ensureOpen();
    const id = ++this.nextId;
    const response = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Electron DevTools ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
    });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(id);
      throw error;
    }
    return response;
  }

  async sendWithoutResponse(method, params = {}) {
    await this.ensureOpen();
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async callPageFunction(functionDeclaration, args = []) {
    const windowResult = await this.send('Runtime.evaluate', {
      expression: 'window',
      returnByValue: false,
    });
    if (windowResult.exceptionDetails) {
      throw new Error(windowResult.exceptionDetails.exception?.description || windowResult.exceptionDetails.text);
    }
    const result = await this.send('Runtime.callFunctionOn', {
      objectId: windowResult.result.objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    try {
      return result.result.value;
    } finally {
      await this.send('Runtime.releaseObject', { objectId: windowResult.result.objectId });
    }
  }

  async callApi(methodName, args = []) {
    assert.ok(['attachSession', 'listSessions', 'quitForReleaseSmoke', 'readyPty', 'writePty'].includes(methodName), 'Unsupported release smoke API method');
    return this.callPageFunction(
      'function (name, values) { return this.spawneaApi[name](...values); }',
      [methodName, args],
    );
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.fail(new Error('Electron DevTools connection closed'));
  }
}

async function connectToRenderer(port) {
  const targets = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const pages = (await response.json()).filter((target) => target.type === 'page');
    return pages.length ? pages : null;
  }, 'the packaged renderer DevTools target');
  const page = targets[0];
  const client = new DevToolsClient(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await waitFor(async () => client.evaluate(
    `Boolean(window.spawneaApi && document.querySelector('[data-testid="spawnea-ui-root"]'))`
  ), 'the renderer and preload bridge');
  return client;
}

async function startApp(env) {
  const port = await freePort();
  const args = [`--remote-debugging-port=${port}`];
  if (platform === 'linux') args.push('--ozone-platform-hint=auto');
  appProcess = spawn(appExecutable, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const capture = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
  appProcess.stdout.on('data', capture);
  appProcess.stderr.on('data', capture);
  appProcess.on('error', (error) => { output = `${output}\n${error.message}`.slice(-8_000); });
  appProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) console.error(`Spawnea exited (${code}${signal ? `, ${signal}` : ''}): ${output}`);
  });

  await waitFor(async () => {
    if (appProcess.exitCode !== null || appProcess.signalCode !== null) {
      throw new Error(`Packaged Spawnea exited before opening (code ${appProcess.exitCode}, signal ${appProcess.signalCode}): ${output}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok;
    } catch {
      return false;
    }
  }, 'the packaged Electron window');
  devToolsClient = await connectToRenderer(port);
  return devToolsClient;
}

async function closeApp({ allowForcedTermination = false } = {}) {
  if (devToolsClient) {
    await devToolsClient.callApi('quitForReleaseSmoke');
    devToolsClient.close();
    devToolsClient = undefined;
  }
  if (!appProcess) return;
  const closingProcess = appProcess;
  const exited = () => closingProcess.exitCode !== null || closingProcess.signalCode !== null;
  let forcedSignal;
  await waitFor(() => exited(), 'Spawnea to close cleanly', 15_000).catch(() => {
    forcedSignal = 'SIGTERM';
    closingProcess.kill('SIGTERM');
  });
  if (forcedSignal) {
    await waitFor(() => exited(), 'Spawnea process exit after SIGTERM', 10_000).catch(() => {
      forcedSignal = 'SIGKILL';
      closingProcess.kill('SIGKILL');
    });
    if (forcedSignal === 'SIGKILL') {
      await waitFor(() => exited(), 'Spawnea process exit after SIGKILL', 5_000).catch(() => undefined);
    }
  }
  if (exited()) appProcess = undefined;
  else throw new Error('Spawnea process remained alive after SIGKILL');
  if (forcedSignal && !allowForcedTermination) {
    throw new Error(`Packaged Spawnea did not shut down cleanly; it required ${forcedSignal}`);
  }
}

async function findAppExecutable() {
  if (platform === 'linux') {
    const artifact = await findArtifact('.AppImage');
    await chmod(artifact, 0o755);
    extractedAppImageDir = join(root, 'appimage');
    await mkdir(extractedAppImageDir);
    run(artifact, ['--appimage-extract'], { cwd: extractedAppImageDir, captureStdout: false });
    artifactRoot = join(extractedAppImageDir, 'squashfs-root');
    appExecutable = join(artifactRoot, 'AppRun');
    return;
  }

  if (platform === 'darwin') {
    const artifact = await findArtifact('.dmg');
    mountedDmg = join(root, 'mounted-dmg');
    await mkdir(mountedDmg);
    run('hdiutil', ['attach', artifact, '-nobrowse', '-readonly', '-mountpoint', mountedDmg]);
    const appName = (await readdir(mountedDmg)).find((name) => name.endsWith('.app'));
    assert.ok(appName, 'The DMG must contain the Spawnea application');
    const appBundle = join(mountedDmg, appName);
    appExecutable = join(appBundle, 'Contents', 'MacOS', 'Spawnea');
    mcpHelper = join(appBundle, 'Contents', 'Resources', 'spawnea-mcp');
    return;
  }

  if (platform === 'win32') {
    const installer = await findArtifact('.exe');
    installedDirectory = join(root, 'installed');
    await mkdir(installedDirectory);
    windowsInstallerAttempted = true;
    run(installer, ['/S', `/D=${installedDirectory}`]);
    appExecutable = join(installedDirectory, 'Spawnea.exe');
    await access(join(installedDirectory, 'Uninstall Spawnea.exe'));
    return;
  }

  throw new Error(`Unsupported package smoke platform: ${platform}`);
}

async function findArtifact(extension) {
  const artifactDirectory = resolve(process.env.SPAWNEA_RELEASE_ARTIFACT_DIR || join(repoRoot, 'release'));
  const entries = await readdir(artifactDirectory);
  const artifact = entries.find((entry) => entry.toLowerCase().endsWith(extension.toLowerCase())
    && !entry.toLowerCase().includes('uninstaller'));
  assert.ok(artifact, `No ${extension} release artifact found in ${artifactDirectory}`);
  return join(artifactDirectory, artifact);
}

async function initializeFixture() {
  if (platform !== 'win32') {
    controlSocketDir = await mkdtemp(join('/tmp', 'spw-'));
    controlSocket = join(controlSocketDir, 'control.sock');
  } else {
    controlSocketDir = runtime;
    controlSocket = join(runtime, 'control.sock');
  }
  await Promise.all([
    mkdir(appData, { recursive: true, mode: 0o700 }),
    mkdir(runtime, { recursive: true, mode: 0o700 }),
    mkdir(project, { recursive: true, mode: 0o700 }),
    mkdir(shimDir, { recursive: true, mode: 0o700 }),
    mkdir(tmuxTmpDir, { recursive: true, mode: 0o700 }),
    mkdir(controlSocketDir, { recursive: true, mode: 0o700 }),
  ]);

  if (platform !== 'win32') {
    tmuxBinary = run('which', ['tmux']).trim();
    assert.ok(tmuxBinary, 'tmux is required for the disposable session smoke');
    const shim = join(shimDir, 'tmux');
    await writeFile(shim, `#!/bin/sh\nexec ${shellQuote(tmuxBinary)} -L ${shellQuote(socketName)} "$@"\n`, { mode: 0o700 });
    await chmod(shim, 0o700);
    const git = run('which', ['git']).trim();
    run(git, ['init', '--initial-branch=main', project]);
    await writeFile(join(project, 'README.md'), 'Disposable release smoke fixture.\n');
    run(git, ['-C', project, 'add', 'README.md']);
    run(git, ['-C', project, '-c', 'user.name=Spawnea Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-m', 'Create disposable smoke fixture']);
  }

  const yaml = `version: 1\nhosts:\n  local:\n    name: Release Smoke Host\n    enabled: true\n    projects:\n      release-smoke:\n        name: Release Smoke Project\n        path: ${JSON.stringify(project)}\n        enabled: true\n    harnesses:\n      release-smoke-shell:\n        name: Release Smoke Shell\n        command: sh\n        args: []\n        enabled: true\n`;
  await writeFile(configPath, yaml, { mode: 0o600 });

  const env = {
    ...process.env,
    SPAWNEA_USER_DATA_DIR: appData,
    SPAWNEA_CONFIG: configPath,
    SPAWNEA_LOG_FILE: join(root, 'spawnea.log'),
    SPAWNEA_CONTROL_ENABLED: platform === 'win32' ? '0' : '1',
    SPAWNEA_CONTROL_RUNTIME_DIR: runtime,
    SPAWNEA_CONTROL_RUNTIME_FILE: controlRuntimeFile,
    SPAWNEA_CONTROL_SOCKET: controlSocket,
    SPAWNEA_CHECK_INTERVAL_MS: '3600000',
    SPAWNEA_RELEASE_SMOKE: '1',
    ...(platform !== 'win32' ? {
      PATH: `${shimDir}${delimiter}${process.env.PATH || ''}`,
      TMUX_TMPDIR: tmuxTmpDir,
    } : {}),
  };
  return env;
}

async function checkRendererIpc(client) {
  const result = await client.evaluate(`(async () => {
    if (!window.spawneaApi || !document.querySelector('[data-testid="spawnea-ui-root"]')) return { ok: false, reason: 'renderer or preload missing' };
    const sessions = await window.spawneaApi.listSessions();
    return { ok: Array.isArray(sessions), sessions: sessions.length };
  })()`);
  assert.equal(result?.ok, true, `Renderer/preload IPC round trip failed: ${JSON.stringify(result)}`);
  assert.equal(result.sessions, 0, 'The isolated user-data directory must begin without sessions');
  logResult('renderer-preload-ipc', 'passed');
}

async function createAndExerciseSession(client, marker) {
  const setup = await client.evaluate(`(async () => {
    const session = await window.spawneaApi.createSession({
      serverId: 'local',
      projectId: 'local:release-smoke',
      agentId: 'local:release-smoke-shell',
      task: 'release smoke session',
      useWorktree: false,
    });
    return { sessionId: session.id, tmuxSessionName: session.tmuxSessionName };
  })()`);
  assert.ok(setup?.sessionId, 'The packaged application should create a disposable local session');
  smokeSession = setup;
  await attachAndExerciseSession(client, setup.sessionId, marker);
}

async function attachAndExerciseSession(client, sessionId, marker) {
  await client.evaluate(`(() => {
    const api = window.spawneaApi;
    window.__spawneaReleaseSmokeOutput = '';
    window.__spawneaReleaseSmokeUnsubscribe?.();
    window.__spawneaReleaseSmokeUnsubscribe = api.onPtyData((channelId, data) => {
      if (channelId !== window.__spawneaReleaseSmokeChannel) return;
      window.__spawneaReleaseSmokeOutput = (window.__spawneaReleaseSmokeOutput + data).slice(-4096);
      api.ackPty(channelId, new TextEncoder().encode(data).length);
    });
  })()`);
  const setup = await client.callApi('attachSession', [sessionId, 80, 24]);
  assert.ok(setup?.ptyChannelId, 'The disposable session should attach through preload IPC');
  await client.callPageFunction('function (channelId) { this.__spawneaReleaseSmokeChannel = channelId; }', [setup.ptyChannelId]);
  await client.callApi('readyPty', [setup.ptyChannelId]);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  const disableEchoCommand = 'stty -echo\r';
  await client.callApi('writePty', [setup.ptyChannelId, disableEchoCommand]);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  const splitAt = Math.ceil(marker.length / 2);
  const command = `printf '%s\\n' ${shellQuote(marker.slice(0, splitAt))}${shellQuote(marker.slice(splitAt))}\r`;
  assert.ok(!command.includes(marker), 'The terminal input must not contain the complete output marker');
  await client.callApi('writePty', [setup.ptyChannelId, command]);
  let output;
  try {
    output = await waitFor(async () => {
      const value = await client.evaluate('window.__spawneaReleaseSmokeOutput');
      return value.includes(marker) ? value : null;
    }, `bounded PTY output ${marker}`, 10_000);
  } catch (error) {
    const terminalOutput = await client.evaluate('window.__spawneaReleaseSmokeOutput').catch(() => '<unavailable>');
    throw new Error(`${error.message}; observed PTY output: ${JSON.stringify(terminalOutput.slice(-512))}`);
  }
  assert.ok(output.length <= 4096, 'The smoke PTY output buffer must remain bounded');
  logResult(`session-terminal-${marker}`, 'passed');
}

async function checkMcpHelper(env) {
  if (platform === 'win32') {
    logResult('packaged-mcp-helper', 'unsupported', 'Windows MCP transport is not implemented');
    return;
  }
  const helperPath = process.env.SPAWNEA_RELEASE_MCP_HELPER || mcpHelper || join(artifactRoot, 'resources', 'spawnea-mcp');
  const helper = await readFile(helperPath);
  assert.ok(helper.length > 0, 'The packaged MCP helper must be present and non-empty');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio'),
  ]);
  const transport = new StdioClientTransport({
    command: helperPath,
    args: ['--runtime-file', controlRuntimeFile],
    env: Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'SPAWNEA_SESSION_ID')),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'spawnea-release-smoke', version: '1.0.0' });
  let helperOutput = '';
  transport.stderr?.on('data', (chunk) => { helperOutput = `${helperOutput}${chunk}`.slice(-2_000); });
  try {
    console.log('Starting packaged MCP helper connection');
    await withTimeout(client.connect(transport), 'packaged MCP helper initialization').catch((error) => {
      throw new Error(`${error.message}${helperOutput ? `; helper output: ${helperOutput.trim()}` : ''}`);
    });
    logResult('packaged-mcp-helper-initialize', 'passed');
    const { tools } = await withTimeout(client.listTools(), 'packaged MCP helper tool discovery');
    assert.ok(tools.some((tool) => tool.name === 'spawnea_get_state'), 'The packaged MCP helper must expose the authenticated Spawnea gateway');
    logResult('packaged-mcp-helper-tools', 'passed');
    const state = await withTimeout(client.callTool({ name: 'spawnea_get_state', arguments: {} }), 'packaged MCP helper tool call');
    assert.ok(!state.isError, 'The packaged MCP helper should complete a gateway tool call');
    logResult('packaged-mcp-helper-state-call', 'passed');
  } finally {
    await withTimeout(client.close(), 'packaged MCP helper client close', 5_000).catch(() => undefined);
    await withTimeout(transport.close(), 'packaged MCP helper process close', 5_000).catch(() => undefined);
  }
}

async function cleanup() {
  console.log('Cleaning isolated release smoke state');
  let cleanupError;
  await closeApp({ allowForcedTermination: true }).catch((error) => { cleanupError = error; });
  let windowsUninstallError;
  if (platform === 'win32' && installedDirectory && windowsInstallerAttempted) {
    const uninstaller = join(installedDirectory, 'Uninstall Spawnea.exe');
    try {
      await access(uninstaller);
      run(uninstaller, ['/S'], { cwd: installedDirectory });
    } catch (error) {
      windowsUninstallError = error;
    }
  }
  if (tmuxBinary) {
    spawnSync(tmuxBinary, ['-L', socketName, 'kill-server'], { stdio: 'ignore', env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } });
  }
  if (mountedDmg) {
    spawnSync('hdiutil', ['detach', mountedDmg, '-quiet'], { stdio: 'ignore' });
  }
  if (platform !== 'win32' && controlSocketDir) await rm(controlSocketDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  if (windowsUninstallError) throw new Error(`Failed to remove the Windows smoke installation: ${windowsUninstallError.message}`);
  if (cleanupError) throw cleanupError;
}

try {
  assert.ok(typeof WebSocket === 'function', 'Node.js with built-in WebSocket support is required');
  const env = await initializeFixture();
  await findAppExecutable();
  logResult('artifact', 'selected', platform);

  let client = await startApp(env);
  await checkRendererIpc(client);
  if (platform !== 'win32') {
    await createAndExerciseSession(client, `spawnea-release-smoke-${process.pid}`);
    console.log('Requesting first packaged Spawnea process to close');
    await closeApp();
    logResult('packaged-app-first-close', 'passed');

    const alive = spawnSync(tmuxBinary, ['-L', socketName, 'has-session', '-t', smokeSession.tmuxSessionName], {
      stdio: 'ignore',
      env,
      timeout: 5_000,
    });
    assert.equal(alive.status, 0, 'Closing Spawnea must leave the disposable tmux session running');
    logResult('tmux-survives-app-close', 'passed');

    console.log('Restarting the packaged Spawnea process');
    client = await startApp(env);
    const restoredSessions = await client.callApi('listSessions');
    const restored = restoredSessions.some((session) => session.id === smokeSession.sessionId);
    assert.equal(restored, true, 'Restarting the packaged app should recover the saved session');
    await attachAndExerciseSession(client, smokeSession.sessionId, `spawnea-release-restart-${process.pid}`);
    logResult('tmux-session-reconnect-after-restart', 'passed');
  } else {
    logResult('local-tmux-session-lifecycle', 'unsupported', 'Windows local session adapter is Unix-only');
  }

  await checkMcpHelper(env);

  await closeApp();
  console.log('Verifying the disposable tmux session survived application exit');
  logResult('packaged-artifact-launch', 'passed', `${platform}/${process.arch}`);
} catch (error) {
  logResult('packaged-artifact-smoke', 'failed', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanup();
}
