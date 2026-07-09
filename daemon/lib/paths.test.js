import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripQuotes,
  toAbsoluteHostPath,
  resolveRoot,
  toContainerPath,
  toHostPath,
  classifyByExtension,
  resolveHostPath,
} from './paths.js';

const roots = [
  { id: 'github', hostPath: 'C:\\work\\git\\github\\cveld', containerPath: '/workspaces/github' },
  {
    id: 'onedrive-business',
    hostPath: 'C:\\Users\\CarlintVeld\\OneDrive - CloudNation',
    containerPath: '/workspaces/onedrive-business',
  },
];

test('stripQuotes removes surrounding double quotes from an Explorer-copied path', () => {
  assert.equal(stripQuotes('"C:\\work\\git\\github\\cveld\\Experiments"'), 'C:\\work\\git\\github\\cveld\\Experiments');
  assert.equal(stripQuotes('C:\\no\\quotes'), 'C:\\no\\quotes');
});

test('toAbsoluteHostPath resolves .. segments and normalizes slashes', () => {
  assert.equal(
    toAbsoluteHostPath('C:/work/git/github/cveld/Experiments/../Experiments/foo'),
    'C:\\work\\git\\github\\cveld\\Experiments\\foo',
  );
});

test('toAbsoluteHostPath strips a trailing separator', () => {
  assert.equal(toAbsoluteHostPath('C:\\work\\git\\github\\cveld\\'), 'C:\\work\\git\\github\\cveld');
});

test('resolveRoot matches a path nested under a root', () => {
  const match = resolveRoot(roots, 'C:\\work\\git\\github\\cveld\\Experiments\\foo');
  assert.deepEqual(match, { root: roots[0], relativePath: 'Experiments/foo' });
});

test('resolveRoot matches the root path itself with an empty relative path', () => {
  const match = resolveRoot(roots, 'C:\\work\\git\\github\\cveld');
  assert.deepEqual(match, { root: roots[0], relativePath: '' });
});

test('resolveRoot is case-insensitive', () => {
  const match = resolveRoot(roots, 'c:\\WORK\\git\\GitHub\\cveld\\experiments');
  assert.deepEqual(match, { root: roots[0], relativePath: 'experiments' });
});

test('resolveRoot rejects a sibling folder that merely shares a prefix', () => {
  assert.equal(resolveRoot(roots, 'C:\\work\\git\\github\\cveldX\\foo'), null);
});

test('resolveRoot returns null (fail closed) for a path outside every root', () => {
  assert.equal(resolveRoot(roots, 'C:\\Windows\\System32'), null);
});

test('toContainerPath joins root containerPath with the relative path', () => {
  assert.equal(toContainerPath(roots[0], 'Experiments/foo'), '/workspaces/github/Experiments/foo');
});

test('toContainerPath returns the bare containerPath for an empty relative path', () => {
  assert.equal(toContainerPath(roots[0], ''), '/workspaces/github');
});

test('toHostPath joins root hostPath with the relative path', () => {
  assert.equal(toHostPath(roots[0], 'Experiments/foo'), 'C:\\work\\git\\github\\cveld\\Experiments\\foo');
});

test('toHostPath returns the bare root hostPath for an empty relative path', () => {
  assert.equal(toHostPath(roots[0], ''), 'C:\\work\\git\\github\\cveld');
});

test('toHostPath and resolveRoot are inverses', () => {
  const match = resolveRoot(roots, 'C:\\work\\git\\github\\cveld\\Experiments\\foo');
  assert.equal(toHostPath(match.root, match.relativePath), 'C:\\work\\git\\github\\cveld\\Experiments\\foo');
});

test('classifyByExtension distinguishes .code-workspace files from folders', () => {
  assert.equal(classifyByExtension('C:\\foo\\bar.code-workspace'), 'workspace');
  assert.equal(classifyByExtension('C:\\foo\\bar'), 'folder');
});

test('resolveHostPath runs the full pipeline for a quoted, nested path', () => {
  const result = resolveHostPath(roots, '"C:\\work\\git\\github\\cveld\\Experiments\\my.code-workspace"');
  assert.deepEqual(result, {
    rootId: 'github',
    relativePath: 'Experiments/my.code-workspace',
    hostPath: 'C:\\work\\git\\github\\cveld\\Experiments\\my.code-workspace',
    containerPath: '/workspaces/github/Experiments/my.code-workspace',
    type: 'workspace',
  });
});

test('resolveHostPath fails closed for a path outside all roots', () => {
  assert.equal(resolveHostPath(roots, 'D:\\some\\other\\place'), null);
});

test('resolveHostPath handles a root containing a space (OneDrive - CloudNation)', () => {
  const result = resolveHostPath(roots, 'C:\\Users\\CarlintVeld\\OneDrive - CloudNation\\Projects\\foo');
  assert.deepEqual(result, {
    rootId: 'onedrive-business',
    relativePath: 'Projects/foo',
    hostPath: 'C:\\Users\\CarlintVeld\\OneDrive - CloudNation\\Projects\\foo',
    containerPath: '/workspaces/onedrive-business/Projects/foo',
    type: 'folder',
  });
});
