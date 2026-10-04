const test = require('node:test');
const assert = require('node:assert/strict');

const {
  explainChange,
  buildPrompt,
  validateExplanation,
  parseModelJson,
  extractQuotedSpans,
  hashChanges,
  CATEGORIES,
  LAYOUT_CHANGE,
  MAX_PARAGRAPHS
} = require('./explainer');

// A typical price change as diff.js would emit it.
const PRICE_DIFF = [
  { type: 'removed', text: 'Price: $10/month.' },
  { type: 'added', text: 'Price: $12/month.' }
];

// Returns a fake model that replies with `reply` and records how often it ran.
function fakeModel(reply) {
  const calls = [];
  const fn = async (messages, temperature) => {
    calls.push({ messages, temperature });
    return typeof reply === 'function' ? reply(messages) : reply;
  };
  fn.calls = calls;
  return fn;
}

const json = (obj) => JSON.stringify(obj);

// --- buildPrompt ---------------------------------------------------------------

test('buildPrompt numbers paragraphs from 1 and labels added/removed', () => {
  const { text, truncated } = buildPrompt(PRICE_DIFF);
  assert.equal(text, '[1] REMOVED: Price: $10/month.\n[2] ADDED: Price: $12/month.');
  assert.equal(truncated, false);
});

test('buildPrompt reports truncation when the diff exceeds the char budget', () => {
  const big = [{ type: 'added', text: 'x'.repeat(20000) }];
  const { truncated } = buildPrompt(big);
  assert.equal(truncated, true);
});

// --- parseModelJson ------------------------------------------------------------

test('parseModelJson extracts JSON wrapped in prose or code fences', () => {
  const wrapped = 'Sure! Here you go:\n```json\n{"category":"price"}\n```\nHope that helps.';
  assert.deepEqual(parseModelJson(wrapped), { category: 'price' });
});

test('parseModelJson returns null for garbage rather than throwing', () => {
  assert.equal(parseModelJson('not json at all'), null);
  assert.equal(parseModelJson('{ broken: '), null);
  assert.equal(parseModelJson(''), null);
  assert.equal(parseModelJson(null), null);
});

test('parseModelJson rejects a bare array', () => {
  assert.equal(parseModelJson('[1,2,3]'), null);
});

// --- extractQuotedSpans --------------------------------------------------------

test('extractQuotedSpans finds straight and curly quoted spans', () => {
  assert.deepEqual(extractQuotedSpans('It now says "Price: $12/month." here'), ['Price: $12/month.']);
  assert.deepEqual(extractQuotedSpans('It now says “$12/month” here'), ['$12/month']);
  assert.deepEqual(extractQuotedSpans('no quotes here'), []);
});

// --- validateExplanation: the enforcement gate ---------------------------------

test('a well-formed answer is verified and its quotes resolved from our own array', () => {
  const out = validateExplanation(
    { category: 'price', summary: 'The monthly price rose from $10 to $12.', quote_ids: [1, 2] },
    PRICE_DIFF
  );
  assert.equal(out.verified, true);
  assert.equal(out.category, 'price');
  assert.equal(out.summary, 'The monthly price rose from $10 to $12.');
  // Text comes from the diff, never from the model.
  assert.deepEqual(out.quotes, ['Price: $10/month.', 'Price: $12/month.']);
});

test('an out-of-range quote id is discarded, keeping only ids we issued', () => {
  const out = validateExplanation(
    { category: 'price', summary: 'The price changed.', quote_ids: [1, 99, -3, 2.5] },
    PRICE_DIFF
  );
  assert.equal(out.verified, true);
  assert.deepEqual(out.quotes, ['Price: $10/month.']);
});

test('duplicate quote ids are collapsed', () => {
  const out = validateExplanation(
    { category: 'price', summary: 'The price changed.', quote_ids: [2, 2, 2] },
    PRICE_DIFF
  );
  assert.deepEqual(out.quotes, ['Price: $12/month.']);
});

test('no valid quote ids means no evidence, so the summary is dropped', () => {
  for (const quote_ids of [[], [99], 'nope', undefined]) {
    const out = validateExplanation(
      { category: 'price', summary: 'Trust me, the price went up.', quote_ids },
      PRICE_DIFF
    );
    assert.equal(out.verified, false, `quote_ids=${JSON.stringify(quote_ids)}`);
    assert.equal(out.summary, null);
    assert.deepEqual(out.quotes, []);
    assert.equal(out.reason, 'no_valid_quotes');
  }
});

test('a figure invented inside the summary is rejected even with valid ids', () => {
  // The diff only ever mentions $10 and $12; the model claims $15.
  const out = validateExplanation(
    { category: 'price', summary: 'The price rose to "$15/month" this month.', quote_ids: [1, 2] },
    PRICE_DIFF
  );
  assert.equal(out.verified, false);
  assert.equal(out.reason, 'quote_not_in_diff');
  assert.equal(out.summary, null);
});

test('a quoted span that does appear in the diff is allowed', () => {
  const out = validateExplanation(
    { category: 'price', summary: 'It now reads "Price: $12/month." instead.', quote_ids: [2] },
    PRICE_DIFF
  );
  assert.equal(out.verified, true);
  assert.match(out.summary, /\$12\/month/);
});

test('a quoted span is matched despite whitespace and case differences', () => {
  const diff = [{ type: 'added', text: 'Cancellation fee: $25.' }];
  const out = validateExplanation(
    { category: 'fees', summary: 'Now says "cancellation   FEE:  $25."', quote_ids: [1] },
    diff
  );
  assert.equal(out.verified, true);
});

test('an unknown category becomes null but the explanation still stands', () => {
  const out = validateExplanation(
    { category: 'vibes', summary: 'The price changed.', quote_ids: [1] },
    PRICE_DIFF
  );
  assert.equal(out.verified, true);
  assert.equal(out.category, null);
});

test('the model may not claim the reserved layout_change category', () => {
  const out = validateExplanation(
    { category: LAYOUT_CHANGE, summary: 'Everything moved around.', quote_ids: [1] },
    PRICE_DIFF
  );
  assert.equal(out.category, null);
});

test('every offered category is accepted', () => {
  for (const category of CATEGORIES) {
    const out = validateExplanation(
      { category, summary: 'Something changed.', quote_ids: [1] },
      PRICE_DIFF
    );
    assert.equal(out.category, category);
  }
});

test('a missing or blank summary is unverified', () => {
  for (const summary of ['', '   ', undefined, 42]) {
    const out = validateExplanation({ category: 'price', summary, quote_ids: [1] }, PRICE_DIFF);
    assert.equal(out.verified, false);
    assert.equal(out.reason, 'no_summary');
  }
});

test('an over-long summary is capped', () => {
  const out = validateExplanation(
    { category: 'price', summary: 'a'.repeat(1000), quote_ids: [1] },
    PRICE_DIFF
  );
  assert.equal(out.summary.length, 300);
});

test('null or non-object model output is unverified, not a crash', () => {
  for (const raw of [null, undefined, 'string', 7]) {
    const out = validateExplanation(raw, PRICE_DIFF);
    assert.equal(out.verified, false);
    assert.equal(out.reason, 'unparseable');
  }
});

// --- hashChanges ---------------------------------------------------------------

test('hashChanges is stable for the same diff and differs for another', () => {
  assert.equal(hashChanges(PRICE_DIFF), hashChanges([...PRICE_DIFF]));
  assert.notEqual(hashChanges(PRICE_DIFF), hashChanges([{ type: 'added', text: 'other' }]));
  assert.equal(typeof hashChanges([]), 'string');
});

// --- explainChange: orchestration ----------------------------------------------

test('explainChange returns a verified explanation on a good model reply', async () => {
  const model = fakeModel(json({
    category: 'price',
    summary: 'The monthly price rose from $10 to $12.',
    quote_ids: [1, 2]
  }));

  const out = await explainChange(PRICE_DIFF, { callModel: model });
  assert.equal(out.verified, true);
  assert.equal(out.category, 'price');
  assert.deepEqual(out.quotes, ['Price: $10/month.', 'Price: $12/month.']);
  assert.equal(out.skippedLlm, false);
  assert.equal(typeof out.diffHash, 'string');
  assert.equal(model.calls.length, 1);
});

test('explainChange sends the numbered diff as the user message', async () => {
  const model = fakeModel(json({ category: 'price', summary: 'Price changed.', quote_ids: [1] }));
  await explainChange(PRICE_DIFF, { callModel: model });

  const { messages } = model.calls[0];
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /\[1\] REMOVED: Price: \$10\/month\./);
  assert.match(messages[1].content, /\[2\] ADDED: Price: \$12\/month\./);
});

test('explainChange survives an unparseable reply without throwing', async () => {
  const out = await explainChange(PRICE_DIFF, { callModel: fakeModel('I think the price went up?') });
  assert.equal(out.verified, false);
  assert.equal(out.reason, 'unparseable');
  assert.equal(out.summary, null);
});

test('explainChange propagates a model failure to the caller', async () => {
  const boom = async () => { throw new Error('Groq request failed (500)'); };
  await assert.rejects(explainChange(PRICE_DIFF, { callModel: boom }), /Groq request failed/);
});

test('an empty diff is never sent to the model', async () => {
  const model = fakeModel(json({ category: 'price', summary: 'x', quote_ids: [1] }));
  const out = await explainChange([], { callModel: model });
  assert.equal(out.verified, false);
  assert.equal(out.reason, 'empty_diff');
  assert.equal(model.calls.length, 0);
});

test('malformed change entries are filtered out before prompting', async () => {
  const model = fakeModel(json({ category: 'price', summary: 'Price changed.', quote_ids: [1] }));
  const messy = [null, { type: 'added' }, { type: 'added', text: 'Price: $12/month.' }];
  const out = await explainChange(messy, { callModel: model });

  assert.equal(out.verified, true);
  // Only the one well-formed entry is numbered, so [1] resolves to it.
  assert.deepEqual(out.quotes, ['Price: $12/month.']);
});

// --- triage: the cost guarantee ------------------------------------------------

test('a huge diff is labelled layout_change and the model is never called', async () => {
  const model = fakeModel(json({ category: 'price', summary: 'nope', quote_ids: [1] }));
  const huge = Array.from({ length: MAX_PARAGRAPHS + 1 }, (_, i) => ({
    type: 'added',
    text: `Paragraph ${i} of a site redesign.`
  }));

  const out = await explainChange(huge, { callModel: model });

  // This assertion is the cost guarantee: a redesign costs zero tokens.
  assert.equal(model.calls.length, 0);
  assert.equal(out.skippedLlm, true);
  assert.equal(out.category, LAYOUT_CHANGE);
  assert.equal(out.reason, 'too_large');
  // Nothing was claimed by a model, so there is nothing to verify.
  assert.equal(out.verified, true);
  assert.deepEqual(out.quotes, []);
  assert.match(out.summary, /redesign/);
});

test('a diff exactly at the cap is still explained by the model', async () => {
  const model = fakeModel(json({ category: 'cosmetic', summary: 'Wording changed.', quote_ids: [1] }));
  const atCap = Array.from({ length: MAX_PARAGRAPHS }, (_, i) => ({
    type: 'added',
    text: `Paragraph ${i}.`
  }));

  const out = await explainChange(atCap, { callModel: model });
  assert.equal(model.calls.length, 1);
  assert.equal(out.skippedLlm, false);
});
