import { describe, it, expect } from 'vitest';
import { parseHostSystemInfoOutput, fetchHostSystemInfo } from '../src/host-info.js';
import { MockHostAdapter } from '../src/mock-host.js';

describe('HostSystemInfo', () => {
  it('parses multi-section telemetry output accurately', () => {
    const rawOutput = `
===UNAME===
Linux 6.8.0-generic-microsoft-standard-WSL2 x86_64
===OS===
NAME="Ubuntu"
VERSION="22.04.4 LTS (Jammy Jellyfish)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 22.04.4 LTS"
VERSION_ID="22.04"
===CPU===
model name	: 13th Gen Intel(R) Core(TM) i5-1340P
===CORES===
16
===MEM===
MemTotal:       16147456 kB
===UPTIME===
up 2 hours, 15 minutes
===SHELL===
/bin/bash
`;

    const info = parseHostSystemInfoOutput('rpi-host', rawOutput);

    expect(info.serverId).toBe('rpi-host');
    expect(info.osName).toBe('Ubuntu 22.04.4 LTS');
    expect(info.kernel).toBe('Linux 6.8.0-generic-microsoft-standard-WSL2 x86_64');
    expect(info.arch).toBe('x86_64');
    expect(info.cpuModel).toBe('13th Gen Intel(R) Core(TM) i5-1340P (16 cores)');
    expect(info.totalMemory).toBe('15.4 GB');
    expect(info.uptime).toBe('2 hours, 15 minutes');
    expect(info.shell).toBe('/bin/bash');
  });

  it('fetches host system info via HostAdapter and handles errors gracefully', async () => {
    const host = new MockHostAdapter('dev-workstation');
    host.customRules.push({
      pattern: '===UNAME===',
      response: {
        stdout: `
===UNAME===
Linux 6.6.10-arch1-1 x86_64
===OS===
PRETTY_NAME="Arch Linux"
NAME="Arch Linux"
===CPU===
model name	: AMD Ryzen 9 5950X 16-Core Processor
===CORES===
32
===MEM===
MemTotal:       65839104 kB
===UPTIME===
up 3 days, 4 hours
===SHELL===
/usr/bin/zsh
`,
        stderr: '',
        exitCode: 0,
      },
    });

    const info = await fetchHostSystemInfo(host);
    expect(info).not.toBeNull();
    expect(info?.osName).toBe('Arch Linux');
    expect(info?.arch).toBe('x86_64');
    expect(info?.cpuModel).toBe('AMD Ryzen 9 5950X 16-Core Processor (32 cores)');
    expect(info?.totalMemory).toBe('62.8 GB');
    expect(info?.uptime).toBe('3 days, 4 hours');
  });

  it('returns null on command failure without throwing', async () => {
    const host = new MockHostAdapter('offline-host');
    host.shouldFailConnection = true;

    const info = await fetchHostSystemInfo(host);
    expect(info).toBeNull();
  });
});
