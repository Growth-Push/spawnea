import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DetectedOutputBanner } from './DetectedOutputBanner';
import type { Artifact } from '@spawnea/domain';

describe('DetectedOutputBanner Component', () => {
  const mockArtifact: Artifact = {
    id: 'art-1',
    sessionId: 'sess-1',
    direction: 'output',
    remotePath: '/repo/TO_DELETE_README.md',
    filename: 'TO_DELETE_README.md',
    mimeType: 'text/markdown',
    sizeBytes: 1024,
    createdAt: new Date(),
  };

  it('renders filename and triggers action callbacks', () => {
    const onPreview = vi.fn();
    const onViewInArtifacts = vi.fn();
    const onDismiss = vi.fn();

    render(
      <DetectedOutputBanner
        artifact={mockArtifact}
        onPreview={onPreview}
        onViewInArtifacts={onViewInArtifacts}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText('TO_DELETE_README.md')).toBeDefined();

    fireEvent.click(screen.getByTestId('preview-detected-artifact-button'));
    expect(onPreview).toHaveBeenCalledWith(mockArtifact);

    fireEvent.click(screen.getByTestId('view-in-artifacts-button'));
    expect(onViewInArtifacts).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('dismiss-detected-banner-button'));
    expect(onDismiss).toHaveBeenCalled();
  });
});
