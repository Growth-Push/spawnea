import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReconnectionBanner } from './ReconnectionBanner.js';
import type { HostConnectionState } from '@spawnea/domain';

describe('ReconnectionBanner', () => {
  it('returns null when host is connected', () => {
    const connectedState: HostConnectionState = {
      serverId: 'srv-1',
      status: 'connected',
      attempt: 0,
      maxAttempts: 5,
    };

    const { container } = render(
      <ReconnectionBanner hostState={connectedState} onRetryNow={vi.fn()} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders reconnecting attempt status and provides Retry Now trigger', () => {
    const onRetryNow = vi.fn();
    const reconnectingState: HostConnectionState = {
      serverId: 'srv-1',
      status: 'reconnecting',
      attempt: 2,
      maxAttempts: 5,
      nextRetryDelayMs: 2000,
      error: 'Connection reset by peer',
    };

    render(
      <ReconnectionBanner hostState={reconnectingState} onRetryNow={onRetryNow} />
    );

    expect(screen.getByTestId('reconnection-banner')).toBeDefined();
    expect(screen.getByText(/Reconnecting host... attempt 2\/5/)).toBeDefined();
    expect(screen.getByTestId('reconnection-error-message').textContent).toContain('Connection reset by peer');
    expect(screen.getByTestId('reconnection-spinner')).toBeDefined();

    const retryBtn = screen.getByTestId('reconnect-retry-button');
    expect(retryBtn.textContent).toContain('Retry now');
    fireEvent.click(retryBtn);

    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('renders disconnected state when retry attempts are exhausted', () => {
    const onRetryNow = vi.fn();
    const disconnectedState: HostConnectionState = {
      serverId: 'srv-1',
      status: 'disconnected',
      attempt: 5,
      maxAttempts: 5,
      error: 'Connection lost (Network unreachable). Stopped after 5 attempts.',
    };

    render(
      <ReconnectionBanner hostState={disconnectedState} onRetryNow={onRetryNow} />
    );

    expect(screen.getByTestId('reconnection-banner')).toBeDefined();
    expect(screen.getByText('Host Connection Lost')).toBeDefined();
    expect(screen.getByTestId('reconnection-offline-icon')).toBeDefined();
    expect(screen.getByTestId('reconnection-error-message').textContent).toContain('Stopped after 5 attempts');

    const retryBtn = screen.getByTestId('reconnect-retry-button');
    fireEvent.click(retryBtn);
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('disables retry button while isRetrying is true', () => {
    const reconnectingState: HostConnectionState = {
      serverId: 'srv-1',
      status: 'reconnecting',
      attempt: 3,
      maxAttempts: 5,
    };

    render(
      <ReconnectionBanner hostState={reconnectingState} onRetryNow={vi.fn()} isRetrying={true} />
    );

    const retryBtn = screen.getByTestId('reconnect-retry-button') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(true);
  });
});
