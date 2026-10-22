import { describe, expect, it } from 'vitest';
import type { Agent, Project, Server, Session } from '@spawnea/domain';
import { formatSessionAgentContext, redactAgentContextValue } from './session-agent-context';

const createdAt = new Date('2026-01-01T00:00:00Z');
// Encode explicit fictional input and assemble synthetic markers at runtime.
const fictionalBasicCredential = btoa('fictional:secret');
const privateKeyMarker = (boundary: 'BEGIN' | 'END', type = '') =>
  ['-----', boundary, ' ', type, 'PRIVATE', ' KEY', '-----'].join('');
const session: Session = {
  id: 'session-example', name: 'Example', serverId: 'host-example', projectId: 'project-example',
  agentId: 'agent-example', task: 'Review a sample change', worktreePath: '/srv/worktrees/example',
  branch: 'feat/example', tmuxSessionName: 'example', tmuxWindowName: 'editor',
  status: 'idle', createdAt, lastActivityAt: createdAt,
};
const project: Project = { id: session.projectId, serverId: session.serverId, name: 'Example', rootPath: '/srv/projects/example', createdAt };
const agent: Agent = { id: session.agentId, name: 'Example Agent', harness: 'hermes', command: 'excluded-command', argsTemplate: ['excluded-argument'], envVars: { EXAMPLE: 'excluded-environment' }, createdAt };
const server: Server = { id: session.serverId, name: 'Example Host', host: 'excluded-connection-target', sshPort: 22, enabled: true, createdAt };

describe('session agent context sheet', () => {
  it.each([
    ['Compare [password: fictional-first] and [token: fictional-second]', 'Compare [[REDACTED CREDENTIAL]] and [[REDACTED CREDENTIAL]]'],
    ['[password: fictional-first] then [token: fictional-second] then [secret: fictional-third] ordinary suffix', '[[REDACTED CREDENTIAL]] then [[REDACTED CREDENTIAL]] then [[REDACTED CREDENTIAL]] ordinary suffix'],
    ['- [db.password: fictional-first] versus [api_key: fictional-second] (keep brackets [])', '- [[REDACTED CREDENTIAL]] versus [[REDACTED CREDENTIAL]] (keep brackets [])'],
    ['[password: fictional-first] and [token: "fictional]second"] end', '[[REDACTED CREDENTIAL]] and [[REDACTED CREDENTIAL]] end'],
    ["[password: 'fictional]first'] and [token: fictional-second] end", '[[REDACTED CREDENTIAL]] and [[REDACTED CREDENTIAL]] end'],
    ['password: fictional]suffix', '[REDACTED CREDENTIAL]'],
    ['[password: fictional-first] ordinary password: ordinary prose', '[[REDACTED CREDENTIAL]] ordinary password: ordinary prose'],
    ['[password: fictional-first] ordinary password: ordinary prose [token: fictional-second]', '[[REDACTED CREDENTIAL]] ordinary password: ordinary prose [[REDACTED CREDENTIAL]]'],
  ])('reexamines retained flow tails with forward progress: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected}`),
    );
  });

  it.each([
    ['[password: fictional-flow-value]', '[[REDACTED CREDENTIAL]]'],
    ['- [password: fictional-flow-value]', '- [[REDACTED CREDENTIAL]]'],
    ['[password: fictional-flow-value] ordinary text', '[[REDACTED CREDENTIAL]] ordinary text'],
    ['[name: keep, db.password: fictional-flow-value]', '[name: keep, [REDACTED CREDENTIAL]]'],
    ['[password: fictional-flow-value, name: keep]', '[[REDACTED CREDENTIAL], name: keep]'],
    ['[password: "fictional]value", name: keep]', '[[REDACTED CREDENTIAL], name: keep]'],
    ["- [password: 'fictional]value'] after=keep", '- [[REDACTED CREDENTIAL]] after=keep'],
    ['password: fictional]suffix', '[REDACTED CREDENTIAL]'],
    ['Review password: ordinary words', 'Review password: ordinary words'],
    ['postgres://fictional-user:fictional#pass?word@example.invalid/db', 'postgres://[REDACTED]@example.invalid/db'],
    ['postgres://fictional-user:fictional?pass#word@example.invalid/db', 'postgres://[REDACTED]@example.invalid/db'],
    ['postgres://fictional-user:fictional%23pass%3Fword@example.invalid/db', 'postgres://[REDACTED]@example.invalid/db'],
    ['https://[2001:db8::1]:8080?email=fictional@example.test', 'https://[2001:db8::1]:8080?email=fictional@example.test'],
    ['https://example.com:8080?email=fictional@example.test', 'https://example.com:8080?email=fictional@example.test'],
    ['https://example.com:8080#email=fictional@example.test', 'https://example.com:8080#email=fictional@example.test'],
    ['https://example.com/path/fictional@example.test', 'https://example.com/path/fictional@example.test'],
    ['https://example.com?email=fictional@example.test', 'https://example.com?email=fictional@example.test'],
    ['https://example.com#email=fictional@example.test', 'https://example.com#email=fictional@example.test'],
  ])('preserves flow and URL boundaries: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected}`),
    );
  });

  it.each([
    ['%TAG !e! tag:yaml.org,2002:\n---\npassword: !e!str "fictional,secret-suffix"\nname: keep', '%TAG !e! tag:yaml.org,2002:\n---\n[REDACTED CREDENTIAL]\nname: keep'],
    ['password: ! "fictional,secret-suffix" after=keep', '[REDACTED CREDENTIAL] after=keep'],
    ['- "db.password": &shared.anchor "fictional,secret-suffix", name: keep', '- [REDACTED CREDENTIAL], name: keep'],
    ['password: &shared.anchor\n- fictional-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: !e!str &shared.anchor |-\n  fictional-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: &shared.anchor !<tag:yaml.org,2002:str> "fictional,secret-suffix"', '[REDACTED CREDENTIAL]'],
    [String.raw`password: 'fictional\' suffix' after=keep`, '[REDACTED CREDENTIAL] after=keep'],
    [String.raw`- 'db.password': 'fictional\' suffix words'; name: keep`, '- [REDACTED CREDENTIAL]; name: keep'],
    [String.raw`password: 'fictional\' after='keep'`, "[REDACTED CREDENTIAL] after='keep'"],
    [String.raw`password: 'fictional\', name: ordinary`, '[REDACTED CREDENTIAL], name: ordinary'],
    [String.raw`password: 'fictional\' # ordinary 'quoted' comment`, "[REDACTED CREDENTIAL] # ordinary 'quoted' comment"],
    [String.raw`password: 'fictional\' db.name='keep'`, "[REDACTED CREDENTIAL] db.name='keep'"],
  ])('bounds lexical properties and legacy quote cuts: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['db.password: fictional-value db.name=keep', '[REDACTED CREDENTIAL] db.name=keep'],
    ['password: fictional-value app.db.name = keep, next: ordinary', '[REDACTED CREDENTIAL] app.db.name = keep, next: ordinary'],
    ['db.password: "fictional-value db.name=inside" db.name=keep', '[REDACTED CREDENTIAL] db.name=keep'],
    ['db.password=fictional-value db.name=keep', '[REDACTED CREDENTIAL] db.name=keep'],
    ['db.password: fictional-value after=keep\nname: ordinary', '[REDACTED CREDENTIAL] after=keep\nname: ordinary'],
    ['Review db.password: ordinary words db.name=keep', 'Review db.password: ordinary words db.name=keep'],
  ])('preserves dotted ordinary assignment neighbors: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['db.password: |\n  fictional-dotted-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['  db.password:\n    fictional-dotted-value\n  name: keep', '  [REDACTED CREDENTIAL]\n  name: keep'],
    ['- "db.APP_SECRET_KEY": >-\n    fictional-dotted-value\n  name: keep', '- [REDACTED CREDENTIAL]\n  name: keep'],
    ["'db.client_secret': fictional-inline after=keep\nname: keep", '[REDACTED CREDENTIAL] after=keep\nname: keep'],
    ['db.password=fictional-inline after=keep', '[REDACTED CREDENTIAL] after=keep'],
    ['db.description: |\n  ordinary body\nname: keep', 'db.description: |\n  ordinary body\nname: keep'],
    ['Review db.password: ordinary words', 'Review db.password: ordinary words'],
    ['password: &shared\n- fictional-sequence-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: !!str\n- fictional-sequence-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['- secret: &shared !vault\n  - fictional-sequence-value\n- name: keep', '- [REDACTED CREDENTIAL]\n- name: keep'],
    ['password: !vault &shared # fictional header\n- fictional-sequence-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['  password:\n  - fictional-first\n# ordinary comment\n  - fictional-suffix\n  name: keep', '  [REDACTED CREDENTIAL]\n  name: keep'],
    ['  password: # fictional header\r\n# ordinary comment\r\n\r\n  - fictional-value\r\n  name: keep', '  [REDACTED CREDENTIAL]\r\n  name: keep'],
    ['  - secret:\n    - fictional-first\n# ordinary comment\n    - fictional-suffix\n  - name: keep\n# ordinary trailing comment', '  - [REDACTED CREDENTIAL]\n  - name: keep\n# ordinary trailing comment'],
    ['  password:\n# ordinary comment\n  name: keep', '  password:\n# ordinary comment\n  name: keep'],
    ['  password: |\n    fictional-body\n# ordinary comment\n  - ordinary-item', '  [REDACTED CREDENTIAL]\n# ordinary comment\n  - ordinary-item'],
    ['  password: fictional-inline\n# ordinary comment\n  - ordinary-item', '  [REDACTED CREDENTIAL]\n# ordinary comment\n  - ordinary-item'],
  ])('preserves known-key and empty-header boundaries: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['password:\n- fictional-sequence-value\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['  password:\n  - fictional-first\n  - fictional-second\n  name: keep\nnext: keep', '  [REDACTED CREDENTIAL]\n  name: keep\nnext: keep'],
    ['- secret:\n  - fictional-sequence-value\n- name: keep', '- [REDACTED CREDENTIAL]\n- name: keep'],
    ['  - "APP_SECRET_KEY":\n    - fictional-first\n      nested: fictional-second\n    - fictional-third\n    name: keep\n  - name: next', '  - [REDACTED CREDENTIAL]\n    name: keep\n  - name: next'],
    ["'client_secret': # fictional comment\r\n\r\n# fictional intervening comment\r\n- fictional-first\r\n# fictional item comment\r\n- fictional-second\r\nname: keep", '[REDACTED CREDENTIAL]\r\nname: keep'],
    ['password:\n-\n  fictional-nested-value\n- fictional-second\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password:\n- fictional-sequence-value', '[REDACTED CREDENTIAL]'],
    ['password: fictional-inline\n- ordinary-item\nname: keep', '[REDACTED CREDENTIAL]\n- ordinary-item\nname: keep'],
    ['password: |\n- ordinary-item\nname: keep', '[REDACTED CREDENTIAL]\n- ordinary-item\nname: keep'],
    ['description:\n- ordinary-item\nname: keep', 'description:\n- ordinary-item\nname: keep'],
    ['password: fictional-inline\n-not-a-sequence\nname: keep', '[REDACTED CREDENTIAL]\n-not-a-sequence\nname: keep'],
  ])('bounds indentless credential sequences: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['credential:\n  "username": fictional-first\n  value: fictional-suffix\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ["password:\n  'username': fictional-first\n  value: fictional-suffix\nname: keep", '[REDACTED CREDENTIAL]\nname: keep'],
    ['- credential:\r\n    "username" : fictional-first\r\n    "value": fictional-suffix\r\n  name: keep', '- [REDACTED CREDENTIAL]\r\n  name: keep'],
    ["  - password:\n      'username': fictional-first\n      'value': fictional-suffix\n    name: keep", '  - [REDACTED CREDENTIAL]\n    name: keep'],
    ['password: "fictional-first\n  fictional-middle" extra-content\n  fictional-suffix\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password:\n  "fictional-value"   \n  ordinary continuation\nname: keep', '[REDACTED CREDENTIAL]\n  ordinary continuation\nname: keep'],
    ["- password:\r\n    'fictional-value' # fictional comment\r\n    ordinary continuation\r\n  name: keep", '- [REDACTED CREDENTIAL]\r\n    ordinary continuation\r\n  name: keep'],
    ['password: "fictional-first\n  fictional-last" # fictional comment\n  ordinary continuation\nname: keep', '[REDACTED CREDENTIAL]\n  ordinary continuation\nname: keep'],
  ])('ends quoted continuations only at scalar tails: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['password: !!str "fictional,secret-suffix" after=keep, name: keep', '[REDACTED CREDENTIAL] after=keep, name: keep'],
    ['- APP_SECRET_KEY: &shared \'fictional,secret-suffix\', name: keep', '- [REDACTED CREDENTIAL], name: keep'],
    ['  "APP_SECRET_KEY": !vault "fictional,secret-suffix"', '  [REDACTED CREDENTIAL]'],
    ['  - password: &shared !!str "fictional,secret-suffix" after=keep', '  - [REDACTED CREDENTIAL] after=keep'],
    ["'APP_SECRET_KEY': !!str &shared 'fictional,secret-suffix'; name: keep", '[REDACTED CREDENTIAL]; name: keep'],
    ['password: !<tag:yaml.org,2002:str> "fictional,secret-suffix"', '[REDACTED CREDENTIAL]'],
    [String.raw`password: 'fictional\''secret-suffix'`, '[REDACTED CREDENTIAL]'],
    [String.raw`- 'APP_SECRET_KEY': 'fictional\\''secret-suffix' after=keep`, '- [REDACTED CREDENTIAL] after=keep'],
    [String.raw`"APP_SECRET_KEY": 'fictional\\\''secret-suffix'`, '[REDACTED CREDENTIAL]'],
    [String.raw`password: 'fictional\', name: keep`, '[REDACTED CREDENTIAL], name: keep'],
    [String.raw`password: 'fictional\\', name: keep`, '[REDACTED CREDENTIAL], name: keep'],
    [String.raw`password: 'fictional\,secret-suffix' after=keep`, '[REDACTED CREDENTIAL] after=keep'],
    [String.raw`password: 'fictional\''first` + "\n  secret-suffix'", '[REDACTED CREDENTIAL]'],
    ['password: &shared !!str "fictional,first\n  secret-suffix"', '[REDACTED CREDENTIAL]'],
    [String.raw`password='fictional\'secret-suffix' after=keep`, '[REDACTED CREDENTIAL] after=keep'],
    [String.raw`password: 'fictional\'secret-suffix' after=keep`, '[REDACTED CREDENTIAL] after=keep'],
    ['description: !!str "ordinary,content"', 'description: !!str "ordinary,content"'],
    ['Review password: !!str "ordinary,content"', 'Review password: !!str "ordinary,content"'],
  ])('preserves scalar lexical boundaries: case %#', (input, redacted) => {
    const task = `${input}\nname: keep`;
    const expected = `${redacted}\nname: keep`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each(['password', 'APP_SECRET_KEY', "'APP_SECRET_KEY'", '"servicePassword"'].flatMap((key) =>
    [': ', '='].flatMap((separator) =>
      ["'fictional''secret-suffix'", "'fictional''middle''secret-suffix'", "'''fictional'''"].flatMap((quoted) =>
        ['', '  - '].map((prefix) => ({ key, separator, quoted, prefix }))))),
  )('masks complete doubled-quote values for $prefix$key$separator$quoted', ({ key, separator, quoted, prefix }) => {
    const task = `${prefix}${key}${separator}${quoted} after=keep, name: keep\nname: next`;
    const expected = `${prefix}[REDACTED CREDENTIAL] after=keep, name: keep\nname: next`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each(['', '  ', '- ', '  - '].flatMap((prefix) =>
    ['password', 'APP_SECRET_KEY', '"servicePassword"', "'client_secret'"].flatMap((key) =>
      ['', ' # fictional comment', ' fictional first part', ' "fictional first part', " 'fictional first part"].map((start) => ({ prefix, key, start })))),
  )('masks structured scalar continuations for $prefix$key:$start', ({ prefix, key, start }) => {
    const indent = ' '.repeat(prefix.length);
    const closing = start.includes('"') ? '"' : start.includes("'") ? "'" : '';
    const task = `${prefix}${key}:${start}\r\n\r\n${indent}    fictional continuation\r\n${indent}  fictional final part${closing}\r\n${indent}name: keep\r\nnext: keep`;
    const expected = `${prefix}[REDACTED CREDENTIAL]\r\n${indent}name: keep\r\nnext: keep`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['password:\n  fictional body', '[REDACTED CREDENTIAL]'],
    ['password: # fictional comment\n  fictional body\n\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password:\n  "fictional first\n    fictional last"\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ["password:\n  'fictional first\n    fictional last'\nname: keep", '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: "fictional \\" first\n  fictional last"\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ["password: 'fictional '' first\n  fictional last'\nname: keep", '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: fictional\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: fictional after=keep\nname: keep', '[REDACTED CREDENTIAL] after=keep\nname: keep'],
    ['password: "fictional" after=keep\n  ordinary continuation\nname: keep', '[REDACTED CREDENTIAL] after=keep\n  ordinary continuation\nname: keep'],
    ['password: fictional, name: keep\nnext: keep', '[REDACTED CREDENTIAL], name: keep\nnext: keep'],
    ['password: fictional\n\nname: keep', '[REDACTED CREDENTIAL]\n\nname: keep'],
    ['password: "fictional first\n  fictional last"\n  ordinary continuation\nname: keep', '[REDACTED CREDENTIAL]\n  ordinary continuation\nname: keep'],
    ['description: first\n    ordinary continuation\n  ordinary last\nname: keep', 'description: first\n    ordinary continuation\n  ordinary last\nname: keep'],
    ['Implement password: first\n  ordinary continuation', 'Implement password: first\n  ordinary continuation'],
    ['Review - password: first\n  ordinary continuation', 'Review - password: first\n  ordinary continuation'],
  ])('preserves scalar and ordinary-text boundaries: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each(['&shared', '!!str', '!<tag:yaml.org,2002:str>', '&shared !!str', '!!str &shared', '&shared !<tag:yaml.org,2002:str>', '!<tag:yaml.org,2002:str> &shared'].flatMap((properties) =>
    ['', '  - '].flatMap((prefix) =>
      ['|', '>-', '|2+', '>+2'].flatMap((indicator) =>
        ['password', '"APP_SECRET_KEY"', 'description'].map((key) => ({ properties, prefix, indicator, key })))),
  ))('handles block node properties $properties with $prefix$key: $indicator', ({ properties, prefix, indicator, key }) => {
    const indent = ' '.repeat(prefix.length);
    const task = `${prefix}${key}: ${properties} ${indicator} # fictional properties\r\n\r\n${indent}  fictional-property-body\r\n${indent}  second fictional line\r\n${indent}name: keep\r\n${indent}copy: *shared`;
    const expected = key === 'description' ? task : `${prefix}[REDACTED CREDENTIAL]\r\n${indent}name: keep\r\n${indent}copy: *shared`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each(['|', '>', '|-', '>+', '|2', '>2-', '|+2', '>-2'].flatMap((indicator) =>
    ['', '  ', '- ', '  - '].flatMap((prefix) =>
      ['password', 'APP_SECRET_KEY', '"servicePassword"', "'client_secret'"].map((key) => ({ indicator, prefix, key }))),
  ))('masks sensitive block scalar $prefix$key: $indicator without consuming neighbors', ({ indicator, prefix, key }) => {
    const contentIndent = ' '.repeat(prefix.length + 2);
    const neighborIndent = ' '.repeat(prefix.length);
    const task = `settings:\n${prefix}${key}: ${indicator} # fictional block\n\n${contentIndent}fictional block content\n${contentIndent}second fictional line\n   \n${neighborIndent}name: ordinary-service\nnext: keep`;
    const expected = `settings:\n${prefix}[REDACTED CREDENTIAL]\n${neighborIndent}name: ordinary-service\nnext: keep`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['password: |\n  fictional body', '[REDACTED CREDENTIAL]'],
    ['- password: |\n    fictional body\n  name: keep\n- name: next', '- [REDACTED CREDENTIAL]\n  name: keep\n- name: next'],
    ['password: |\n\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: >-\nname: keep', '[REDACTED CREDENTIAL]\nname: keep'],
    ['password: |\n  \n', '[REDACTED CREDENTIAL]\n'],
    ['password: |\r\n  fictional body\r\nname: keep', '[REDACTED CREDENTIAL]\r\nname: keep'],
    ['password: |\n    fictional body\n  ordinary: keep', '[REDACTED CREDENTIAL]\n  ordinary: keep'],
    ['description: |\n  ordinary block\n  second line\nname: keep', 'description: |\n  ordinary block\n  second line\nname: keep'],
    ['Implement password: |\n  ordinary task continuation', 'Implement password: |\n  ordinary task continuation'],
    ['Review - password: >\n  ordinary task continuation', 'Review - password: >\n  ordinary task continuation'],
  ])('preserves block boundaries and ordinary text: case %#', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ')}`),
    );
  });

  it.each(['', '  '].flatMap((indent) =>
    ['password', 'APP_SECRET_KEY', 'servicePassword'].flatMap((key) =>
      ['fictional-yaml-value', '"fictional yaml value"', "'fictional yaml value'"].map((value) => ({ indent, key, value }))),
  ))('masks YAML sequence credential fields with indentation "$indent", key $key and value $value', ({ indent, key, value }) => {
    const task = `credentials:\n${indent}- ${key}: ${value}\n${indent}  name: fictional-service\n${indent}  enabled: true`;
    const expected = `credentials:\n${indent}- [REDACTED CREDENTIAL]\n${indent}  name: fictional-service\n${indent}  enabled: true`;
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['- password: fictional-yaml-value', '- [REDACTED CREDENTIAL]'],
    ['  -\tAPP_SECRET_KEY: "fictional yaml value"', '  -\t[REDACTED CREDENTIAL]'],
    ['- name: fictional-service\n  password: fictional-yaml-value', '- name: fictional-service\n  [REDACTED CREDENTIAL]'],
    ['Review - password: reset UI', 'Review - password: reset UI'],
    ['Review inline-password: reset UI', 'Review inline-password: reset UI'],
    ['Review, - password: reset UI', 'Review, - password: reset UI'],
    ['- Implement password: reset UI', '- Implement password: reset UI'],
    ['-password: reset UI', '-password: reset UI'],
    ['Fix authorization: reject expired sessions', 'Fix authorization: reject expired sessions'],
    ['Implement password: reset UI', 'Implement password: reset UI'],
  ])('recognizes only line-start sequence indicators and preserves prose: %s', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it.each([
    ['https://example.com?email=fictional@example.test', 'https://example.com?email=fictional@example.test'],
    ['https://example.com#email=fictional@example.test', 'https://example.com#email=fictional@example.test'],
    ['https://fictional-user:fictional-password@example.invalid?email=fictional@example.test', 'https://[REDACTED]@example.invalid?email=fictional@example.test'],
    ['ssh://fictional-user@example.invalid/path#email=fictional@example.test', 'ssh://[REDACTED]@example.invalid/path#email=fictional@example.test'],
    ['Fix authorization: reject expired sessions', 'Fix authorization: reject expired sessions'],
    ['Implement password: reset UI', 'Implement password: reset UI'],
    ['Discuss password: reset UI, then review', 'Discuss password: reset UI, then review'],
    ['password: fictional multiword value', '[REDACTED CREDENTIAL]'],
    ['ordinary line\n  password: fictional multiword value', 'ordinary line\n  [REDACTED CREDENTIAL]'],
    ['{password: fictional multiword value, ordinary: keep}', '{[REDACTED CREDENTIAL], ordinary: keep}'],
    ['prefix "password": "fictional value", after=keep', 'prefix [REDACTED CREDENTIAL], after=keep'],
    ['Review password=fictional after=keep', 'Review [REDACTED CREDENTIAL] after=keep'],
  ])('preserves prose and URL boundaries while masking structured credentials: %s', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`),
    );
  });

  it('includes only the eight agreed data fields, not launch or connection details', () => {
    const text = formatSessionAgentContext(session, project, agent, server);
    expect(text.match(/^[a-z ]+: /gm)).toHaveLength(8);
    for (const value of [session.id, session.task, project.rootPath, session.worktreePath, session.branch, 'Example Agent (hermes)', server.name, 'example:editor']) expect(text).toContain(value);
    expect(text).not.toContain('excluded-');
    expect(text).not.toContain('permission');
  });

  it('formats the compact sample exactly as one txt block', () => {
    expect(formatSessionAgentContext(session, project, agent, server)).toBe([
      '# Spawnea context', '', '```txt',
      'session id: session-example',
      'task: Review a sample change',
      'project root: /srv/projects/example',
      'worktree path: /srv/worktrees/example',
      'git branch: feat/example',
      'harness agent: Example Agent (hermes)',
      'host server: Example Host',
      'tmux target: example:editor',
      '```', '',
    ].join('\n'));
  });

  it('marks missing fields and catalog path locators unavailable without substituting IDs', () => {
    const text = formatSessionAgentContext({ ...session, task: ' ', branch: '', worktreePath: 'catalog-worktree://example/project/leaf', tmuxSessionName: '' });
    expect(text.match(/Unavailable/g)).toHaveLength(7);
    expect(text).not.toContain(session.projectId);
    expect(text).not.toContain('catalog-');
    expect(formatSessionAgentContext(session, { ...project, rootPath: 'catalog-project://example/project' })).not.toContain('catalog-project://');
  });

  it('rejects stale related records and keeps multiline Markdown-like input literal', () => {
    const text = formatSessionAgentContext({ ...session, projectId: 'other', agentId: 'other', serverId: 'other', task: 'First line\n```\n## Quoted heading\nSecond line' }, project, agent, server);
    expect(text).toContain('````txt\nsession id: session-example\ntask: First line\n  ```\n  ## Quoted heading\n  Second line\nproject root: Unavailable');
    expect(text).toMatch(/\n````\n$/);
    expect(text).not.toContain(project.rootPath);
    expect(text).not.toContain(agent.name);
    expect(text).not.toContain(server.name);
  });

  it.each(['Add basic validation', 'Fix basic sidebar layout'])('preserves ordinary basic prose: %s', (task) => {
    expect(redactAgentContextValue(task)).toBe(task);
    expect(formatSessionAgentContext({ ...session, task })).toContain(`\ntask: ${task}\n`);
  });

  it.each(['authorization', 'credential'])('redacts quoted JSON %s containing Basic credentials', (key) => {
    const credential = fictionalBasicCredential;
    const value = JSON.stringify({ [key]: `Basic ${credential}` });
    expect(redactAgentContextValue(value)).toContain('[REDACTED');
    expect(redactAgentContextValue(value)).not.toContain(credential);
    expect(formatSessionAgentContext({ ...session, task: value })).not.toContain(credential);
  });

  it('preserves ordinary paths and branches with embedded token-like substrings', () => {
    const worktreePath = '/srv/worktrees/task-implementation';
    const branch = 'feat/task-implementation';
    expect(redactAgentContextValue(worktreePath)).toBe(worktreePath);
    expect(redactAgentContextValue(branch)).toBe(branch);
    const text = formatSessionAgentContext({ ...session, worktreePath, branch });
    expect(text).toContain(worktreePath);
    expect(text).toContain(branch);
  });

  it.each(['password', 'passwd', 'api_key', 'api-key', 'apiKey', 'token', 'secret', 'authorization', 'credential'])('redacts quoted JSON credential key %s', (key) => {
    const value = JSON.stringify({ [key]: 'fictional-password', ordinary: 'sample value' });
    expect(redactAgentContextValue(value)).not.toContain('fictional-password');
    expect(redactAgentContextValue(value)).toContain('[REDACTED CREDENTIAL]');
    expect(redactAgentContextValue(value)).toContain('sample value');
    expect(formatSessionAgentContext({ ...session, task: value })).not.toContain('fictional-password');
  });

  it.each([
    'access_token', 'refresh_token', 'client_secret', 'DATABASE_PASSWORD',
    'GITHUB_TOKEN', 'OPENAI_API_KEY', 'accessToken', 'refreshToken',
    'clientSecret', 'databasePassword', 'github-token', 'openai-api-key',
  ].flatMap((key) => [
    { key, form: 'JSON', value: JSON.stringify({ before: 'ordinary data', [key]: 'fictional qualified value', after: 'keep this' }) },
    { key, form: 'unquoted assignment', value: `before=ordinary ${key}=fictional-qualified-value after=keep` },
    { key, form: 'double-quoted assignment', value: `before=ordinary ${key}="fictional qualified value" after=keep` },
    { key, form: 'single-quoted assignment', value: `before=ordinary ${key}='fictional qualified value' after=keep` },
  ]))('redacts the complete qualified key $key in $form and preserves neighbors', ({ key, form, value }) => {
    const expected = form === 'JSON'
      ? '{"before":"ordinary data",[REDACTED CREDENTIAL],"after":"keep this"}'
      : 'before=ordinary [REDACTED CREDENTIAL] after=keep';
    expect(redactAgentContextValue(value)).toBe(expected);
    const text = formatSessionAgentContext({ ...session, task: value }, project, agent, server);
    expect(text).toBe(formatSessionAgentContext(session, project, agent, server).replace(
      'task: Review a sample change', `task: ${expected}`,
    ));
    expect(text).not.toContain(key);
    expect(text).not.toContain('fictional');
  });

  it.each([
    ['password: fictional secret words', '[REDACTED CREDENTIAL]'],
    ['password: fictional secret words, ordinary: keep', '[REDACTED CREDENTIAL], ordinary: keep'],
    ['password: fictional secret words; after=keep', '[REDACTED CREDENTIAL]; after=keep'],
    ['password: fictional secret words\nafter=keep', '[REDACTED CREDENTIAL]\nafter=keep'],
    ['password: fictional secret words after=keep', '[REDACTED CREDENTIAL] after=keep'],
    ['password=fictional after=keep', '[REDACTED CREDENTIAL] after=keep'],
    ['Fix bearer token refresh', 'Fix bearer token refresh'],
    ['Add bearer authentication', 'Add bearer authentication'],
    ['Bearer aBcDeFgH', '[REDACTED AUTHORIZATION]'],
    ['Bearer fictional-bearer-value', '[REDACTED AUTHORIZATION]'],
    ['AWS_SECRET_ACCESS_KEY=fictional-value after=keep', '[REDACTED CREDENTIAL] after=keep'],
    ['{"secretAccessKey":"fictional value","ordinary":"keep"}', '{[REDACTED CREDENTIAL],"ordinary":"keep"}'],
    ...['Authorization', 'HTTP_AUTHORIZATION', 'httpAuthorization'].flatMap((key) =>
      ['Basic', 'Bearer'].flatMap((scheme) => ['x', fictionalBasicCredential].flatMap((token) => [
        [`${key}=${scheme} ${token} after=keep`, '[REDACTED AUTHORIZATION] after=keep'],
        [`${key}: ${scheme} ${token} after=keep`, '[REDACTED AUTHORIZATION] after=keep'],
        [`${key}="${scheme} ${token}" after=keep`, '[REDACTED AUTHORIZATION] after=keep'],
        [`{"${key}":"${scheme} ${token}","ordinary":"keep"}`, '{[REDACTED AUTHORIZATION],"ordinary":"keep"}'],
        [`'${key}': '${scheme} ${token}', ordinary: keep`, '[REDACTED AUTHORIZATION], ordinary: keep'],
      ]))),
  ])('preserves boundaries and ordinary prose: case %#', (value, expected) => {
    expect(redactAgentContextValue(value)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task: value }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace(
        'task: Review a sample change', `task: ${expected.replace(/\n/g, '\n  ')}`,
      ),
    );
  });

  it.each([
    'Add bearer authentication.',
    'Implement Bearer Authentication',
    'Implement Bearer Authentication.',
    'Document bearer authentication, including refresh',
    'Document Bearer Authentication, including refresh',
    'Fix bearer token refresh',
    'Add bearer authentication',
  ])('preserves sentence punctuation and initial capitals in ordinary prose: %s', (task) => {
    expect(redactAgentContextValue(task)).toBe(task);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${task}`),
    );
  });

  it.each([
    ['Bearer fictional-bearer-value.', '[REDACTED AUTHORIZATION].'],
    ['Bearer aBcDeFgH, after=keep', '[REDACTED AUTHORIZATION], after=keep'],
    ['Bearer abc.defgh', '[REDACTED AUTHORIZATION]'],
  ])('retains token-shaped standalone Bearer protection: %s', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected}`),
    );
  });

  it.each([
    ['Bearer abcdefghijklmnopqrstuvwxyz', '[REDACTED AUTHORIZATION]'],
    ['Bearer abcdefghijklmnopqrstuvwxyz.', '[REDACTED AUTHORIZATION].'],
    ['Bearer abcdefghijklmnopqrstuvwxyz, after=keep', '[REDACTED AUTHORIZATION], after=keep'],
    ['Bearer abcdefghijklmnopqrstuvwx', '[REDACTED AUTHORIZATION]'],
    ['Bearer ABCDEFGHIJKLMNOPQRSTUVWXY.', '[REDACTED AUTHORIZATION].'],
    ['Bearer abcdefghijklmnopqrstuvw.', 'Bearer abcdefghijklmnopqrstuvw.'],
    ['Bearer Abcdefghijklmnopqrstuvw, after=keep', 'Bearer Abcdefghijklmnopqrstuvw, after=keep'],
    ['Document bearer internationalization.', 'Document bearer internationalization.'],
    ['Document Bearer Internationalization, including authentication', 'Document Bearer Internationalization, including authentication'],
  ])('applies the conservative alphabetic Bearer length boundary: %s', (task, expected) => {
    expect(redactAgentContextValue(task)).toBe(expected);
    expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
      formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected}`),
    );
  });

  it.each([
    'SECRET_KEY', 'PRIVATE_KEY', 'ACCESS_KEY', 'SIGNING_KEY', 'ENCRYPTION_KEY', 'secretKey',
    'privateKey', 'accessKey', 'signingKey', 'encryptionKey',
    'secret-key', 'private-key', 'access-key', 'signing-key', 'encryption-key',
    'APP_SECRET_KEY', 'servicePrivateKey', 'service-access-key', 'app_signing_key', 'appEncryptionKey',
  ])('masks complete common credential-key suffixes: %s', (key) => {
    for (const [task, expected] of [
      [`{"before":"keep","${key}":"fictional-sensitive-value","after":"keep"}`, '{"before":"keep",[REDACTED CREDENTIAL],"after":"keep"}'],
      [`before=keep ${key}=fictional-sensitive-value after=keep`, 'before=keep [REDACTED CREDENTIAL] after=keep'],
      [`before=keep ${key}="fictional sensitive value" after=keep`, 'before=keep [REDACTED CREDENTIAL] after=keep'],
      [`before=keep ${key}='fictional sensitive value' after=keep`, 'before=keep [REDACTED CREDENTIAL] after=keep'],
    ]) {
      expect(redactAgentContextValue(task)).toBe(expected);
      expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
        formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${expected}`),
      );
    }
  });

  it.each([
    'key', 'PUBLIC_KEY', 'publicKey', 'public-key', 'APP_PUBLIC_KEY', 'publicKeyFingerprint',
    'PRIVATE_KEY_PATH', 'secretKeyName', 'accessKeyId', 'signingKeyAlgorithm', 'encryptionKeyVersion',
    'keyboard', 'monkey', 'cache_key',
  ])('preserves nonsecret key names and public-key metadata: %s', (key) => {
    for (const task of [`before=keep ${key}=ordinary-value after=keep`, `{"${key}":"ordinary-value","after":"keep"}`]) {
      expect(redactAgentContextValue(task)).toBe(task);
      expect(formatSessionAgentContext({ ...session, task }, project, agent, server)).toBe(
        formatSessionAgentContext(session, project, agent, server).replace('task: Review a sample change', `task: ${task}`),
      );
    }
  });

  it('redacts the entire Basic authorization credential', () => {
    const value = `Authorization: Basic ${fictionalBasicCredential}`;
    const redacted = redactAgentContextValue(value);
    expect(redacted).toContain('[REDACTED');
    expect(redacted).not.toContain(fictionalBasicCredential);
    expect(formatSessionAgentContext({ ...session, task: value })).not.toContain(fictionalBasicCredential);
  });

  it.each([
    'op://example-vault/example-item/password',
    'password="fictional credential"',
    'api_key=fictional-key',
    'Bearer fictional-bearer-value',
    'https://fictional-user:fictional-password@example.invalid',
    [privateKeyMarker('BEGIN'), 'fictional-key-body', privateKeyMarker('END')].join('\n'),
    [privateKeyMarker('BEGIN', 'OPENSSH '), 'fictional-unclosed-body'].join('\n'),
    'sk-' + 'fictional'.repeat(5),
    'ghp_' + 'fictional'.repeat(5),
    'glpat-' + 'fictional'.repeat(5),
    'github_pat_' + 'fictional'.repeat(5),
    'xoxb-' + 'fictional'.repeat(5),
  ])('redacts recognizable secret data: case %#', (value) => {
    expect(redactAgentContextValue(value)).toContain('[REDACTED');
    expect(redactAgentContextValue(value)).not.toContain('fictional');
    const text = formatSessionAgentContext({ ...session, task: value, branch: value, worktreePath: value, id: value, tmuxSessionName: value }, { ...project, rootPath: value }, { ...agent, name: value }, { ...server, name: value });
    expect(text).not.toContain('fictional');
    expect(text).not.toContain('op://');
  });
});
