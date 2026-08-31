import type { HostAdapter, HostSystemInfo, Logger } from '@spawnea/domain';
import { createLogger } from '@spawnea/domain';

export const PROBE_HOST_SYSTEM_COMMAND = `(
  echo "===UNAME==="
  uname -srm 2>/dev/null
  echo "===OS==="
  cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null
  echo "===CPU==="
  grep -m 1 'model name' /proc/cpuinfo 2>/dev/null || uname -m 2>/dev/null
  echo "===CORES==="
  grep -c '^processor' /proc/cpuinfo 2>/dev/null || nproc 2>/dev/null
  echo "===MEM==="
  grep 'MemTotal' /proc/meminfo 2>/dev/null || free -h 2>/dev/null
  echo "===UPTIME==="
  uptime -p 2>/dev/null || uptime 2>/dev/null
  echo "===SHELL==="
  echo "$SHELL" 2>/dev/null
)`;

export function parseHostSystemInfoOutput(serverId: string, rawOutput: string): HostSystemInfo {
  const sections: Record<string, string[]> = {};
  let currentSection = 'HEADER';

  const lines = rawOutput.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('===') && trimmed.endsWith('===')) {
      currentSection = trimmed.replace(/===/g, '').trim();
      sections[currentSection] = [];
    } else if (sections[currentSection]) {
      sections[currentSection].push(line);
    }
  }

  // 1. Parse OS Name
  let osName: string | undefined;
  const osLines = sections['OS'] || [];
  for (const line of osLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('PRETTY_NAME=')) {
      osName = trimmed.replace(/^PRETTY_NAME=/, '').replace(/^["']|["']$/g, '');
      break;
    } else if (trimmed.startsWith('NAME=') && !osName) {
      osName = trimmed.replace(/^NAME=/, '').replace(/^["']|["']$/g, '');
    }
  }

  // 2. Parse Uname / Kernel / Arch
  let kernel: string | undefined;
  let arch: string | undefined;
  const unameLines = sections['UNAME'] || [];
  if (unameLines.length > 0 && unameLines[0].trim()) {
    const unameStr = unameLines[0].trim();
    kernel = unameStr;
    const parts = unameStr.split(/\s+/);
    if (parts.length >= 3) {
      arch = parts[parts.length - 1];
    }
  }

  // 3. Parse CPU Model and Core Count
  let cpuModel: string | undefined;
  const cpuLines = sections['CPU'] || [];
  if (cpuLines.length > 0 && cpuLines[0].trim()) {
    const rawCpu = cpuLines[0].trim();
    if (rawCpu.includes(':')) {
      cpuModel = rawCpu.split(':')[1].trim();
    } else {
      cpuModel = rawCpu;
    }
  }

  const coreLines = sections['CORES'] || [];
  if (coreLines.length > 0 && coreLines[0].trim()) {
    const coreCount = parseInt(coreLines[0].trim(), 10);
    if (!isNaN(coreCount) && coreCount > 0 && cpuModel) {
      cpuModel = `${cpuModel} (${coreCount} cores)`;
    }
  }

  // 4. Parse Memory
  let totalMemory: string | undefined;
  const memLines = sections['MEM'] || [];
  for (const line of memLines) {
    if (line.includes('MemTotal:')) {
      const match = line.match(/MemTotal:\s+(\d+)\s+kB/i);
      if (match) {
        const kb = parseInt(match[1], 10);
        const gb = (kb / (1024 * 1024)).toFixed(1);
        totalMemory = `${gb} GB`;
        break;
      }
    } else if (line.startsWith('Mem:')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        totalMemory = parts[1];
        break;
      }
    }
  }

  // 5. Parse Uptime
  let uptime: string | undefined;
  const uptimeLines = sections['UPTIME'] || [];
  if (uptimeLines.length > 0 && uptimeLines[0].trim()) {
    uptime = uptimeLines[0].trim().replace(/^up\s+/, '');
  }

  // 6. Parse Shell
  let shell: string | undefined;
  const shellLines = sections['SHELL'] || [];
  if (shellLines.length > 0 && shellLines[0].trim()) {
    shell = shellLines[0].trim();
  }

  return {
    serverId,
    osName: osName || 'Linux',
    kernel,
    arch,
    cpuModel,
    totalMemory,
    uptime,
    shell,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Probes basic host telemetry (OS, kernel, CPU, memory, uptime) safely without sudo.
 * Returns null if the host is unreachable or probe execution fails.
 */
export async function fetchHostSystemInfo(
  host: HostAdapter,
  logger?: Logger
): Promise<HostSystemInfo | null> {
  const log = logger || createLogger('HostSystemInfo');
  try {
    log.info('Probing host system telemetry', { serverId: host.serverId });
    const result = await host.execute(PROBE_HOST_SYSTEM_COMMAND, { timeoutMs: 5000 });
    if (result.exitCode !== 0 && !result.stdout) {
      log.warn('Failed to probe host system telemetry', {
        serverId: host.serverId,
        exitCode: result.exitCode,
        stderr: result.stderr,
      });
      return null;
    }

    const info = parseHostSystemInfoOutput(host.serverId, result.stdout);
    log.info('Host system telemetry gathered successfully', {
      serverId: host.serverId,
      osName: info.osName,
      kernel: info.kernel,
    });
    return info;
  } catch (err) {
    log.warn('Error querying host system telemetry (best effort)', {
      serverId: host.serverId,
      error: err,
    });
    return null;
  }
}
