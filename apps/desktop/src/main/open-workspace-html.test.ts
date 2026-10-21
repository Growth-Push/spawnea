import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: run });
  return { execFile };
});
import { openWorkspaceHtml } from './open-workspace-html.js';

describe('explicit workspace HTML browser launch', () => {
  beforeEach(() => { run.mockReset(); });

  it.runIf(process.platform === 'linux')('uses the configured browser desktop application, not the HTML association', async () => {
    run.mockResolvedValueOnce({ stdout: 'example-browser.desktop\n' }).mockResolvedValueOnce({ stdout: '' });
    const path = '/workspace/report with spaces.htm';
    await openWorkspaceHtml(path);
    expect(run).toHaveBeenNthCalledWith(1, 'xdg-settings', ['get', 'default-web-browser'], expect.any(Object));
    expect(run).toHaveBeenNthCalledWith(2, 'gtk-launch', ['example-browser.desktop', pathToFileURL(path).href], expect.any(Object));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform === 'linux').each(['', 'browser.desktop\nother.desktop', '--invalid.desktop'])('rejects invalid browser configuration without a file-handler fallback: %s', async (stdout) => {
    run.mockResolvedValue({ stdout });
    await expect(openWorkspaceHtml('/workspace/report.html')).rejects.toThrow('Unable to launch');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === 'linux')('reports missing platform facilities without opening a file association', async () => {
    run.mockRejectedValue(new Error('ENOENT'));
    await expect(openWorkspaceHtml('/workspace/report.html')).rejects.toThrow('xdg-settings, gtk-launch');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform !== 'linux')('reports unsupported platforms explicitly', async () => {
    await expect(openWorkspaceHtml('/workspace/report.html')).rejects.toThrow('Linux only');
    expect(run).not.toHaveBeenCalled();
  });
});
