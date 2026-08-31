import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import { OsIcon, detectOsType, getOsDisplayName } from './OsIcon';

describe('OsIcon', () => {
  describe('detectOsType', () => {
    it('detects Arch Linux and variants', () => {
      expect(detectOsType('Arch Linux')).toBe('arch');
      expect(detectOsType('EndeavourOS Linux')).toBe('arch');
      expect(detectOsType('Manjaro Linux')).toBe('arch');
      expect(detectOsType('Garuda Linux')).toBe('arch');
    });

    it('detects Ubuntu and Debian-family variants', () => {
      expect(detectOsType('Ubuntu 22.04.4 LTS')).toBe('ubuntu');
      expect(detectOsType('Pop!_OS 22.04 LTS')).toBe('ubuntu');
      expect(detectOsType('Linux Mint 21')).toBe('ubuntu');
      expect(detectOsType('Debian GNU/Linux 12 (bookworm)')).toBe('debian');
      expect(detectOsType('Raspbian GNU/Linux 11 (bullseye)')).toBe('raspberry');
      expect(detectOsType('Raspberry Pi OS')).toBe('raspberry');
    });

    it('detects RHEL, Fedora, CentOS, and Enterprise variants', () => {
      expect(detectOsType('Fedora Linux 39')).toBe('fedora');
      expect(detectOsType('Red Hat Enterprise Linux 9')).toBe('redhat');
      expect(detectOsType('CentOS Stream 9')).toBe('centos');
      expect(detectOsType('Rocky Linux 9.3')).toBe('rocky');
      expect(detectOsType('AlmaLinux 9.2')).toBe('almalinux');
    });

    it('detects Alpine, NixOS, openSUSE, Gentoo, BSD, macOS, and Windows', () => {
      expect(detectOsType('Alpine Linux v3.19')).toBe('alpine');
      expect(detectOsType('NixOS 23.11')).toBe('nixos');
      expect(detectOsType('openSUSE Tumbleweed')).toBe('opensuse');
      expect(detectOsType('Gentoo Base System')).toBe('gentoo');
      expect(detectOsType('FreeBSD 14.0-RELEASE')).toBe('freebsd');
      expect(detectOsType('Darwin / macOS')).toBe('macos');
      expect(detectOsType('Windows 11 WSL2')).toBe('windows');
    });

    it('falls back to generic linux for unknown strings', () => {
      expect(detectOsType('Custom Embedded OS')).toBe('linux');
      expect(detectOsType('')).toBe('linux');
      expect(detectOsType(undefined)).toBe('linux');
    });
  });

  describe('getOsDisplayName', () => {
    it('returns human friendly display names', () => {
      expect(getOsDisplayName('arch')).toBe('Arch Linux');
      expect(getOsDisplayName('ubuntu')).toBe('Ubuntu');
      expect(getOsDisplayName('debian')).toBe('Debian');
      expect(getOsDisplayName('raspberry')).toBe('Raspberry Pi OS');
      expect(getOsDisplayName('fedora')).toBe('Fedora');
      expect(getOsDisplayName('macos')).toBe('macOS');
      expect(getOsDisplayName('windows')).toBe('Windows');
      expect(getOsDisplayName('linux')).toBe('Linux');
    });
  });

  describe('OsIcon component', () => {
    it('renders arch icon for Arch Linux string', () => {
      render(<OsIcon osName="Arch Linux" />);
      const icon = screen.getByTestId('os-icon-arch');
      expect(icon).toBeDefined();
      expect(icon.querySelector('title')?.textContent).toBe('Arch Linux');
    });

    it('renders ubuntu icon for Ubuntu string', () => {
      render(<OsIcon osName="Ubuntu 22.04.4 LTS" />);
      const icon = screen.getByTestId('os-icon-ubuntu');
      expect(icon).toBeDefined();
    });

    it('renders raspberry icon for Raspberry Pi server', () => {
      render(<OsIcon osName="Raspberry Pi Server (example-host:22)" />);
      const icon = screen.getByTestId('os-icon-raspberry');
      expect(icon).toBeDefined();
    });

    it('renders custom explicit type', () => {
      render(<OsIcon type="nixos" title="Custom Nix" />);
      const icon = screen.getByTestId('os-icon-nixos');
      expect(icon).toBeDefined();
      expect(icon.querySelector('title')?.textContent).toBe('Custom Nix');
    });
  });
});
