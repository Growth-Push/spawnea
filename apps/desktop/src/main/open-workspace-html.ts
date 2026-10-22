import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);

/** Launch HTML with the configured browser, never its file-type association. */
export async function openWorkspaceHtml(path: string): Promise<void> {
  if (process.platform !== 'linux') {
    throw new Error('Explicit default-browser HTML opening is currently available on Linux only');
  }
  try {
    const { stdout } = await run('xdg-settings', ['get', 'default-web-browser'], { timeout: 5000, maxBuffer: 16384 });
    const desktopId = stdout.trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.desktop$/.test(desktopId)) {
      throw new Error('No valid default browser desktop application is configured');
    }
    await run('gtk-launch', [desktopId, pathToFileURL(path).href], { timeout: 10000, maxBuffer: 16384 });
  } catch (error) {
    throw new Error('Unable to launch the configured browser; xdg-settings, gtk-launch and a default browser are required', { cause: error });
  }
}
