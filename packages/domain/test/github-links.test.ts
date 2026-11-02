import { describe, expect, it } from 'vitest';
import { findGitHubLinks, parseGitHubLink } from '../src/github-links.js';

describe('GitHub links', () => {
  it('canonicalizes resource identity without retaining query or fragment', () => {
    expect(parseGitHubLink('https://github.com/Example/Repo/issues/42?utm_source=x#issuecomment-1')).toEqual({
      url: 'https://github.com/example/repo/issues/42', owner: 'example', repository: 'repo', kind: 'issue', number: '42',
    });
  });

  it('rejects non-resource and unsafe URLs', () => {
    for (const url of ['http://github.com/a/b/issues/1', 'https://github.com.evil/a/b/issues/1', 'https://github.com:443/a/b', ['https://user', 'github.com/a/b/issues/1'].join('@'), 'https://github.com/a/b/issues/0', 'https://github.com/a/b/pull/1/files', 'https://github.com/a/b/../c', 'https://github.com/a/b/tree/main', '#1']) {
      expect(parseGitHubLink(url)).toBeUndefined();
    }
  });

  it('canonicalizes complete repository references without guessing from shorthand', () => {
    expect(parseGitHubLink('https://github.com/Example/my_repo/?x=1#readme')).toEqual({ url: 'https://github.com/example/my_repo', owner: 'example', repository: 'my_repo', kind: 'repository' });
    expect(findGitHubLinks('**https://github.com/Example/my_repo** and example/my_repo #1').map((link) => link.url)).toEqual(['https://github.com/example/my_repo']);
  });

  it('rejects known GitHub site namespaces without rejecting similar owners or repository names', () => {
    for (const url of ['https://github.com/settings/profile', 'https://github.com/ORGS/example', 'https://github.com/topics/typescript', 'https://github.com/users/example', 'https://github.com/organizations/example', 'https://github.com/marketplace/actions', 'https://github.com/search/advanced', 'https://github.com/notifications/participating']) {
      expect(parseGitHubLink(url)).toBeUndefined();
    }
    expect(findGitHubLinks('https://github.com/settings/profile https://github.com/Example/settings https://github.com/example/settings?view=1 https://github.com/settings-team/topics').map((link) => link.url)).toEqual([
      'https://github.com/example/settings', 'https://github.com/settings-team/topics',
    ]);
    expect(parseGitHubLink('https://github.com/example/topics')).toMatchObject({ kind: 'repository' });
    expect(parseGitHubLink('https://github.com/example/settings/issues/3')).toMatchObject({ kind: 'issue', number: '3' });
    expect(parseGitHubLink('https://github.com/example/topics/pull/4')).toMatchObject({ kind: 'pull', number: '4' });
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
