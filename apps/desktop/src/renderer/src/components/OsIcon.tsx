import React from 'react';

export type OsType =
  | 'arch'
  | 'ubuntu'
  | 'debian'
  | 'raspberry'
  | 'fedora'
  | 'redhat'
  | 'centos'
  | 'rocky'
  | 'almalinux'
  | 'alpine'
  | 'nixos'
  | 'opensuse'
  | 'gentoo'
  | 'void'
  | 'kali'
  | 'macos'
  | 'windows'
  | 'freebsd'
  | 'linux';

export function detectOsType(nameOrOsString?: string): OsType {
  if (!nameOrOsString) return 'linux';
  const str = nameOrOsString.toLowerCase();

  if (
    str.includes('arch') ||
    str.includes('endeavour') ||
    str.includes('manjaro') ||
    str.includes('garuda') ||
    str.includes('artix')
  ) {
    return 'arch';
  }
  if (
    str.includes('ubuntu') ||
    str.includes('pop!_os') ||
    str.includes('pop_os') ||
    str.includes('pop-os') ||
    str.includes('mint') ||
    str.includes('elementary') ||
    str.includes('zorin')
  ) {
    return 'ubuntu';
  }
  if (
    str.includes('raspbian') ||
    str.includes('raspberry') ||
    str.includes('rpi')
  ) {
    return 'raspberry';
  }
  if (str.includes('debian')) {
    return 'debian';
  }
  if (str.includes('fedora') || str.includes('nobara') || str.includes('silverblue')) {
    return 'fedora';
  }
  if (
    str.includes('red hat') ||
    str.includes('rhel') ||
    str.includes('redhat')
  ) {
    return 'redhat';
  }
  if (str.includes('centos')) {
    return 'centos';
  }
  if (str.includes('rocky')) {
    return 'rocky';
  }
  if (str.includes('alma')) {
    return 'almalinux';
  }
  if (str.includes('alpine')) {
    return 'alpine';
  }
  if (str.includes('nixos') || str.includes('nix')) {
    return 'nixos';
  }
  if (str.includes('suse') || str.includes('opensuse') || str.includes('tumbleweed') || str.includes('leap')) {
    return 'opensuse';
  }
  if (str.includes('gentoo')) {
    return 'gentoo';
  }
  if (str.includes('void')) {
    return 'void';
  }
  if (str.includes('kali')) {
    return 'kali';
  }
  if (
    str.includes('darwin') ||
    str.includes('mac') ||
    str.includes('apple') ||
    str.includes('osx')
  ) {
    return 'macos';
  }
  if (
    str.includes('windows') ||
    str.includes('wsl') ||
    str.includes('win32') ||
    str.includes('msys') ||
    str.includes('cygwin')
  ) {
    return 'windows';
  }
  if (
    str.includes('freebsd') ||
    str.includes('openbsd') ||
    str.includes('netbsd') ||
    str.includes('dragonfly') ||
    str.includes('bsd')
  ) {
    return 'freebsd';
  }

  return 'linux';
}

export function getOsDisplayName(type: OsType): string {
  switch (type) {
    case 'arch':
      return 'Arch Linux';
    case 'ubuntu':
      return 'Ubuntu';
    case 'debian':
      return 'Debian';
    case 'raspberry':
      return 'Raspberry Pi OS';
    case 'fedora':
      return 'Fedora';
    case 'redhat':
      return 'Red Hat Enterprise Linux';
    case 'centos':
      return 'CentOS';
    case 'rocky':
      return 'Rocky Linux';
    case 'almalinux':
      return 'AlmaLinux';
    case 'alpine':
      return 'Alpine Linux';
    case 'nixos':
      return 'NixOS';
    case 'opensuse':
      return 'openSUSE';
    case 'gentoo':
      return 'Gentoo';
    case 'void':
      return 'Void Linux';
    case 'kali':
      return 'Kali Linux';
    case 'macos':
      return 'macOS';
    case 'windows':
      return 'Windows';
    case 'freebsd':
      return 'FreeBSD';
    case 'linux':
    default:
      return 'Linux';
  }
}

interface OsIconProps {
  osName?: string;
  type?: OsType;
  className?: string;
  title?: string;
  showTitle?: boolean;
}

export function OsIcon({
  osName,
  type: explicitType,
  className = 'w-3.5 h-3.5',
  title,
  showTitle = true,
}: OsIconProps): React.JSX.Element {
  const osType = explicitType || detectOsType(osName);
  const resolvedTitle = title || (showTitle ? (osName || getOsDisplayName(osType)) : undefined);

  switch (osType) {
    case 'arch':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#1793d1] shrink-0`}
          data-testid="os-icon-arch"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path
            d="M12 2L2 21.5L6.5 19.5L10 14.5L11.5 16.5L9.5 19.5L12 20.5L14.5 19.5L12.5 16.5L14 14.5L17.5 19.5L22 21.5L12 2Z"
            fill="currentColor"
          />
        </svg>
      );

    case 'ubuntu':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#e95420] shrink-0`}
          data-testid="os-icon-ubuntu"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <circle cx="12" cy="12" r="10" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="6" cy="15.5" r="1.8" />
          <circle cx="18" cy="15.5" r="1.8" />
          <path d="M12 7.5A4.5 4.5 0 0 0 8.5 14M15.5 14A4.5 4.5 0 0 0 12 7.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      );

    case 'debian':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#d70a53] shrink-0`}
          data-testid="os-icon-debian"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M12 2a10 10 0 0 0-8 16c2 3 6 4 9 3 3-1 5-4 4-7s-3-5-6-4-4 3-3 6 3 3 5 2" />
        </svg>
      );

    case 'raspberry':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#c51a4a] shrink-0`}
          data-testid="os-icon-raspberry"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <circle cx="9" cy="9" r="2" />
          <circle cx="15" cy="9" r="2" />
          <circle cx="6.5" cy="13.5" r="2" />
          <circle cx="12" cy="13.5" r="2" />
          <circle cx="17.5" cy="13.5" r="2" />
          <circle cx="9" cy="18" r="2" />
          <circle cx="15" cy="18" r="2" />
          <path d="M12 2C10.5 4 8.5 4.5 8 5C9.5 5.5 11 5 12 6C13 5 14.5 5.5 16 5C15.5 4.5 13.5 4 12 2Z" fill="#75a928" />
        </svg>
      );

    case 'fedora':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#51a2da] shrink-0`}
          data-testid="os-icon-fedora"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <circle cx="12" cy="12" r="10" fill="#294172" fillOpacity="0.3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M15 7h-2a3 3 0 0 0-3 3v7h2v-4h3v-2h-3v-1a1 1 0 0 1 1-1h2V7Z" fill="currentColor" />
        </svg>
      );

    case 'redhat':
    case 'centos':
    case 'rocky':
    case 'almalinux':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#ee0000] shrink-0`}
          data-testid="os-icon-redhat"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M4 16C5 13 8 12 12 12C16 12 19 13 20 16C21 17 21 18 19 19C16 20.5 8 20.5 5 19C3 18 3 17 4 16Z" />
          <path d="M12 6C9 6 8.5 8 8.5 10C8.5 12 10 13 12 13C14 13 15.5 12 15.5 10C15.5 8 15 6 12 6Z" fill="#ff4d4d" />
        </svg>
      );

    case 'alpine':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#0d597f] shrink-0`}
          data-testid="os-icon-alpine"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M2 19L9.5 5.5L14 13L11.5 17L9.5 13L6 19H2Z" fill="#0d597f" />
          <path d="M12.5 19L16 13L19.5 19H12.5Z" fill="#3884ab" />
        </svg>
      );

    case 'nixos':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#5277c3] shrink-0`}
          data-testid="os-icon-nixos"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M4.93 19.07l14.14-14.14" />
        </svg>
      );

    case 'opensuse':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#73ba25] shrink-0`}
          data-testid="os-icon-opensuse"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="10" cy="10" r="2.5" />
          <circle cx="14" cy="13" r="2" fillOpacity="0.6" />
        </svg>
      );

    case 'macos':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-zinc-300 shrink-0`}
          data-testid="os-icon-macos"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 17 2.94 12.45 4.7 9.39C5.57 7.87 7.13 6.91 8.82 6.88C10.1 6.86 11.32 7.75 12.11 7.75C12.89 7.75 14.37 6.68 15.92 6.84C16.57 6.87 18.39 7.1 19.56 8.82C19.47 8.88 17.39 10.1 17.41 12.63C17.44 15.65 20.06 16.66 20.13 16.69C20.07 16.88 19.67 18.29 18.71 19.5ZM14.96 4.9C15.58 4.15 16 3.1 15.88 2.05C14.98 2.09 13.89 2.65 13.25 3.4C12.68 4.06 12.18 5.14 12.32 6.16C13.32 6.24 14.34 5.65 14.96 4.9Z" />
        </svg>
      );

    case 'windows':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#00a4ef] shrink-0`}
          data-testid="os-icon-windows"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M3 5.5L10.5 4.5V11.5H3V5.5ZM11.5 4.35L21 3V11.5H11.5V4.35ZM3 12.5H10.5V19.5L3 18.5V12.5ZM11.5 12.5H21V21L11.5 19.65V12.5Z" />
        </svg>
      );

    case 'freebsd':
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#ab2b28] shrink-0`}
          data-testid="os-icon-freebsd"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <circle cx="12" cy="13" r="7" />
          <path d="M6 7C6 7 7 4 10 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M18 7C18 7 17 4 14 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case 'linux':
    default:
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={`${className} text-[#fcc624] shrink-0`}
          data-testid="os-icon-linux"
        >
          {resolvedTitle && <title>{resolvedTitle}</title>}
          <path d="M12 2C9.5 2 8 4 8 7C8 8.5 7.5 10 6.5 11C5.5 12 4 14 4 17C4 20 6.5 22 12 22C17.5 22 20 20 20 17C20 14 18.5 12 17.5 11C16.5 10 16 8.5 16 7C16 4 14.5 2 12 2Z" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="10" cy="7" r="1" fill="#fff" />
          <circle cx="14" cy="7" r="1" fill="#fff" />
          <path d="M10 9.5C10.5 10.5 13.5 10.5 14 9.5C13 11 11 11 10 9.5Z" fill="#ff9900" />
        </svg>
      );
  }
}
