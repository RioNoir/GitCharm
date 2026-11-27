// Unit tests for the branch sidebar's multi-selection (Ctrl/Cmd-click, Shift-click).
//
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyBranchClick, pruneBranchSelection, EMPTY_BRANCH_SELECTION, type BranchSelection,
} from '../src/webview/gitLog/utils/branchSelection.ts';

const order = ['main', 'feature/a', 'feature/b', 'fix/c', 'fix/d'];

test('a plain click selects only the clicked branch and anchors there', () => {
  const sel = applyBranchClick(EMPTY_BRANCH_SELECTION, 'local', 'feature/a', 'single', order);
  assert.deepEqual(sel, { section: 'local', names: ['feature/a'], anchor: 'feature/a' });
});

test('Ctrl/Cmd-click adds and removes branches', () => {
  let sel = applyBranchClick(EMPTY_BRANCH_SELECTION, 'local', 'main', 'single', order);
  sel = applyBranchClick(sel, 'local', 'fix/c', 'toggle', order);
  assert.deepEqual(sel.names, ['main', 'fix/c']);
  sel = applyBranchClick(sel, 'local', 'main', 'toggle', order);
  assert.deepEqual(sel.names, ['fix/c']);
  assert.equal(sel.anchor, 'main');
});

test('Shift-click selects the visible range from the anchor, in either direction', () => {
  let sel = applyBranchClick(EMPTY_BRANCH_SELECTION, 'local', 'feature/b', 'single', order);
  sel = applyBranchClick(sel, 'local', 'fix/d', 'range', order);
  assert.deepEqual(sel.names, ['feature/b', 'fix/c', 'fix/d']);
  sel = applyBranchClick(sel, 'local', 'main', 'range', order);
  assert.deepEqual(sel.names, ['main', 'feature/a', 'feature/b']);
  assert.equal(sel.anchor, 'feature/b');
});

test('Shift-click without an anchor selects just the clicked branch', () => {
  const sel = applyBranchClick(EMPTY_BRANCH_SELECTION, 'local', 'fix/c', 'range', order);
  assert.deepEqual(sel.names, ['fix/c']);
});

test('clicking in another section starts a new selection there', () => {
  let sel = applyBranchClick(EMPTY_BRANCH_SELECTION, 'local', 'main', 'single', order);
  sel = applyBranchClick(sel, 'local', 'fix/c', 'toggle', order);
  sel = applyBranchClick(sel, 'remote:origin', 'feature/a', 'toggle', order);
  assert.deepEqual(sel, { section: 'remote:origin', names: ['feature/a'], anchor: 'feature/a' });
});

test('pruning drops branches that no longer exist and keeps the object when nothing changed', () => {
  const sel: BranchSelection = { section: 'local', names: ['main', 'fix/c'], anchor: 'main' };
  assert.equal(pruneBranchSelection(sel, new Set(order)), sel);
  assert.deepEqual(pruneBranchSelection(sel, new Set(['main'])).names, ['main']);
});
