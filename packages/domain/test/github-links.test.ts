import { describe, expect, it } from 'vitest';
import { findGitHubLinks, parseGitHubLink } from '../src/github-links.js';

describe('GitHub links', () => {
  it('canonicalizes resource identity without retaining query or fragment', () => {
    expect(parseGitHubLink('https://github.com/Example/Repo/issues/42?utm_source=x#issuecomment-1')).toEqual({
      url: 'https://github.com/example/repo/issues/42', owner: 'example', repository: 'repo', kind: 'issue', number: '42',
    });
  });

  it('rejects non-resource and unsafe URLs', () => {
    for (const url of ['http://github.com/a/b/issues/1', 'https://github.com.evil/a/b/issues/1', ['https://user', 'github.com/a/b/issues/1'].join('@'), 'https://github.com/a/b/issues/0', 'https://github.com/a/b/pull/1/files', '#1']) {
      expect(parseGitHubLink(url)).toBeUndefined();
    }
  });

  it('deduplicates rendered references and strips surrounding punctuation', () => {
    expect(findGitHubLinks('🙂 (\u001b[32mhttps://github.com/Example/Repo/pull/7\u001b[0m), https://github.com/example/repo/pull/7.')).toEqual([
      { url: 'https://github.com/example/repo/pull/7', owner: 'example', repository: 'repo', kind: 'pull', number: '7' },
    ]);
  });

  it('extracts Markdown-wrapped references without accepting invalid resource suffixes', () => {
    const text = [
      '`https://github.com/Example/my_repo/pull/7`',
      '(**https://github.com/Example/my_repo/issues/8?source=test#detail**),',
      '```https://github.com/example/my_repo/pull/9```!',
      '```\nhttps://github.com/example/my_repo/issues/10\n```',
      '`https://github.com/example/my_repo/pull/11/files`',
      '**https://github.com/example/my_repo/issues/12_invalid**',
      'https://github.com/example/my_repo/pull/13_invalid',
      '#14',
    ].join(' ');
    expect(findGitHubLinks(text).map((link) => link.url)).toEqual([
      'https://github.com/example/my_repo/pull/7',
      'https://github.com/example/my_repo/issues/8',
      'https://github.com/example/my_repo/pull/9',
      'https://github.com/example/my_repo/issues/10',
    ]);
  });
});
