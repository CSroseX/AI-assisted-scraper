const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDiff, splitParagraphs, isNoise } = require('./diff');

test('splitParagraphs collapses whitespace and drops empties', () => {
  assert.deepEqual(splitParagraphs('  a  b \n\n\n  c  \n\n'), ['a b', 'c']);
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs(null), []);
});

test('isNoise flags timestamps, counters and copyright years', () => {
  assert.equal(isNoise('12:34 PM'), true);
  assert.equal(isNoise('482 people viewing this page'), true);
  assert.equal(isNoise('© 2024 Example Inc.'), true);
  assert.equal(isNoise('Loading...'), true);
  assert.equal(isNoise('Monthly subscription is now $12.99'), false);
});

test('computeDiff reports no change for identical text', () => {
  const text = 'Para one.\n\nPara two.';
  const result = computeDiff(text, text);
  assert.equal(result.hasMeaningfulChange, false);
  assert.deepEqual(result.changes, []);
});

test('computeDiff detects an added paragraph', () => {
  const before = 'Intro paragraph.';
  const after = 'Intro paragraph.\n\nNew cancellation fee: $5.';
  const result = computeDiff(before, after);
  assert.equal(result.hasMeaningfulChange, true);
  assert.deepEqual(result.changes, [{ type: 'added', text: 'New cancellation fee: $5.' }]);
});

test('computeDiff detects a removed paragraph', () => {
  const before = 'Intro paragraph.\n\nFree trial available.';
  const after = 'Intro paragraph.';
  const result = computeDiff(before, after);
  assert.deepEqual(result.changes, [{ type: 'removed', text: 'Free trial available.' }]);
});

test('computeDiff detects a modified paragraph as remove+add', () => {
  const before = 'Price: $10/month.';
  const after = 'Price: $12/month.';
  const result = computeDiff(before, after);
  assert.deepEqual(result.changes, [
    { type: 'removed', text: 'Price: $10/month.' },
    { type: 'added', text: 'Price: $12/month.' }
  ]);
});

test('computeDiff filters out noise-only changes', () => {
  const before = 'Terms of service.\n\nLast updated: 1/1/2024';
  const after = 'Terms of service.\n\nLast updated: 6/15/2024';
  const result = computeDiff(before, after);
  assert.equal(result.hasMeaningfulChange, false);
  assert.deepEqual(result.changes, []);
});

test('computeDiff keeps a real change alongside filtered noise', () => {
  const before = 'Terms of service.\n\nCancellation fee: none.\n\nLast updated: 1/1/2024';
  const after = 'Terms of service.\n\nCancellation fee: $25.\n\nLast updated: 6/15/2024';
  const result = computeDiff(before, after);
  assert.equal(result.hasMeaningfulChange, true);
  assert.deepEqual(result.changes, [
    { type: 'removed', text: 'Cancellation fee: none.' },
    { type: 'added', text: 'Cancellation fee: $25.' }
  ]);
});

test('computeDiff handles empty before (first snapshot)', () => {
  const result = computeDiff('', 'Brand new content.');
  assert.deepEqual(result.changes, [{ type: 'added', text: 'Brand new content.' }]);
});
