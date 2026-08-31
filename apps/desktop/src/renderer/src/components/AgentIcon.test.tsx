import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentIcon, detectProviderType, getProviderDisplayName } from './AgentIcon';

describe('AgentIcon Component & detectProviderType', () => {
  it('detects provider types correctly from harness, name, or command', () => {
    expect(detectProviderType('hermes', 'Hermes - GP Dev', 'hermes')).toBe('hermes');
    expect(detectProviderType('antigravity', 'Antigravity Code', 'agy')).toBe('antigravity');
    expect(detectProviderType('claude', 'Claude Code', 'claude')).toBe('claude');
    expect(detectProviderType('codex', 'Codex Agent', 'codex')).toBe('codex');
    expect(detectProviderType('openai', 'ChatGPT', 'gpt')).toBe('codex');
    expect(detectProviderType('deepseek', 'DeepSeek Coder', 'deepseek')).toBe('deepseek');
    expect(detectProviderType('kimi', 'Kimmy Moonshot', 'kimi')).toBe('kimi');
    expect(detectProviderType('ollama', 'Ollama Local', 'ollama')).toBe('ollama');
    expect(detectProviderType('gemini', 'Google Gemini', 'gemini')).toBe('gemini');
    expect(detectProviderType('copilot', 'GitHub Copilot', 'gh copilot')).toBe('copilot');
    expect(detectProviderType('cursor', 'Cursor Agent', 'cursor')).toBe('cursor');
    expect(detectProviderType('mistral', 'Devin Mistral', 'mistral')).toBe('mistral');
    expect(detectProviderType('qwen', 'Qwen Coder', 'qwen')).toBe('qwen');
    expect(detectProviderType('llama', 'Meta Llama 3', 'llama')).toBe('llama');
    expect(detectProviderType('none', 'Terminal', 'bash')).toBe('none');
    expect(detectProviderType('terminal', 'Terminal', 'bash')).toBe('none');
    expect(detectProviderType('custom-tool', 'My Agent', 'bash')).toBe('generic');
  });

  it('renders correct testids for various providers', () => {
    const { unmount } = render(<AgentIcon harness="hermes" />);
    expect(screen.getByTestId('provider-icon-hermes')).toBeDefined();
    unmount();

    render(<AgentIcon harness="antigravity" />);
    expect(screen.getByTestId('provider-icon-antigravity')).toBeDefined();
  });

  it('renders null when harness is none or terminal', () => {
    const { container } = render(<AgentIcon harness="none" />);
    expect(container.firstChild).toBeNull();
  });
});
