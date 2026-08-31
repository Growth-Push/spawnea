import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToastNotification } from './ToastNotification';

describe('ToastNotification Component', () => {
  it('renders title, message, and executes action callback', () => {
    const onAction = vi.fn();
    const onClose = vi.fn();

    render(
      <ToastNotification
        id="t-1"
        title="File Uploaded"
        message=".spawnea/artifacts/image.png"
        actions={[
          {
            label: 'Copy Path',
            onClick: onAction,
          },
        ]}
        onClose={onClose}
        autoCloseMs={0}
      />
    );

    expect(screen.getByText('File Uploaded')).toBeDefined();
    expect(screen.getByText('.spawnea/artifacts/image.png')).toBeDefined();

    fireEvent.click(screen.getByTestId('toast-action-copy-path'));
    expect(onAction).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('close-toast-button'));
    expect(onClose).toHaveBeenCalled();
  });
});
