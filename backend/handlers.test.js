const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GROQ_API_KEY = 'test-key';
process.env.RATE_LIMIT_MAX = '1000';

const {
  app,
  clampTextForModel,
  withRetries,
  callGroq,
  classifyIntentHeuristic,
  classifyIntent,
  routeToHandler,
  handleSpin,
  handleReview,
  handleChat,
  handleSummarize
} = require('./index');

// Replaces axios.post with a fake Groq. `reply` is either a string or a function
// (messages) => string | Error. Records every request body for assertions.
function mockGroq(t, reply) {
  const calls = [];
  t.mock.method(axios, 'post', async (_url, body) => {
    calls.push(body);
    const out = typeof reply === 'function' ? reply(body.messages, calls.length) : reply;
    if (out instanceof Error) throw out;
    return { data: { choices: [{ message: { content: out } }] } };
  });
  return calls;
}

function httpError(status, message = 'boom') {
  const err = new Error(message);
  err.response = { status, data: { error: { message } } };
  return err;
}

// --- clampTextForModel -------------------------------------------------------

test('clampTextForModel leaves short text alone and truncates long text with a notice', () => {
  assert.deepEqual(clampTextForModel('hello', 10), { text: 'hello', truncated: false });
  assert.deepEqual(clampTextForModel(undefined, 10), { text: '', truncated: false });

  const clamped = clampTextForModel('a'.repeat(50), 10);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.text.startsWith('a'.repeat(10)));
  assert.match(clamped.text, /Content truncated/);
});

// --- withRetries ---------------------------------------------------------------

test('withRetries retries retryable failures then succeeds', async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    calls++;
    if (calls < 3) throw httpError(503);
    return 'ok';
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetries does not retry client errors', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => { calls++; throw httpError(400); }, { attempts: 3, baseDelayMs: 1 }),
    /boom/
  );
  assert.equal(calls, 1);
});

test('withRetries gives up after the last attempt and rethrows', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => { calls++; throw httpError(500, 'still down'); }, { attempts: 2, baseDelayMs: 1 }),
    /still down/
  );
  assert.equal(calls, 2);
});

// --- callGroq ------------------------------------------------------------------

test('callGroq sends model, messages and auth header, and returns the content', async (t) => {
  let captured;
  t.mock.method(axios, 'post', async (url, body, config) => {
    captured = { url, body, config };
    return { data: { choices: [{ message: { content: 'hi there' } }] } };
  });
  const out = await callGroq([{ role: 'user', content: 'yo' }], 0.5);
  assert.equal(out, 'hi there');
  assert.match(captured.url, /\/chat\/completions$/);
  assert.equal(captured.body.temperature, 0.5);
  assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'yo' }]);
  assert.equal(captured.config.headers.Authorization, 'Bearer test-key');
});

test('callGroq wraps upstream errors and preserves the status', async (t) => {
  t.mock.method(axios, 'post', async () => { throw httpError(401, 'bad key'); });
  await assert.rejects(callGroq([{ role: 'user', content: 'x' }]), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /Groq request failed \(401\): bad key/);
    return true;
  });
});

test('callGroq reports rate limiting distinctly after retries', async (t) => {
  const post = t.mock.method(axios, 'post', async () => { throw httpError(429, 'slow down'); });
  await assert.rejects(callGroq([{ role: 'user', content: 'x' }]), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /rate limit reached \(429\)/);
    return true;
  });
  assert.equal(post.mock.callCount(), 3); // retried up to the configured attempts
});

// --- intent classification -------------------------------------------------------

test('classifyIntentHeuristic maps keywords to intents', () => {
  assert.equal(classifyIntentHeuristic('Please summarize this'), 'summarize');
  assert.equal(classifyIntentHeuristic('give me the key points'), 'summarize');
  assert.equal(classifyIntentHeuristic('tl;dr / tldr please'), 'summarize');
  assert.equal(classifyIntentHeuristic('review the grammar'), 'review');
  assert.equal(classifyIntentHeuristic('critique this'), 'review');
  assert.equal(classifyIntentHeuristic('rewrite it simpler'), 'spin');
  assert.equal(classifyIntentHeuristic('paraphrase the intro'), 'spin');
});

test('classifyIntentHeuristic keeps open questions and empty input as chat', () => {
  assert.equal(classifyIntentHeuristic('What is this page about?'), 'chat');
  assert.equal(classifyIntentHeuristic("what's the article about"), 'chat');
  assert.equal(classifyIntentHeuristic('who wrote this?'), 'chat');
  assert.equal(classifyIntentHeuristic(''), 'chat');
  assert.equal(classifyIntentHeuristic(undefined), 'chat');
});

test('classifyIntent skips the LLM when the heuristic already decided', async (t) => {
  const post = t.mock.method(axios, 'post', async () => { throw new Error('should not be called'); });
  assert.equal(await classifyIntent('summarize this'), 'summarize');
  assert.equal(post.mock.callCount(), 0);
});

test('classifyIntent asks the LLM for ambiguous messages and normalises its label', async (t) => {
  const calls = mockGroq(t, '  Review\n');
  assert.equal(await classifyIntent('is it any good?'), 'review');
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /is it any good\?/);
});

test('classifyIntent falls back to chat on unexpected labels and on errors', async (t) => {
  mockGroq(t, 'banana');
  assert.equal(await classifyIntent('hmm'), 'chat');
  t.mock.restoreAll();

  t.mock.method(axios, 'post', async () => { throw httpError(400); });
  assert.equal(await classifyIntent('hmm'), 'chat');
});

// --- handlers --------------------------------------------------------------------

test('handleSpin uses the default prompt, returns metadata and flags truncation', async (t) => {
  const calls = mockGroq(t, 'spun text');
  const out = await handleSpin('original');
  assert.equal(out.spun, 'spun text');
  assert.equal(out.metadata.truncated, false);
  assert.match(calls[0].messages[0].content, /^Rewrite in modern English/);
  assert.match(calls[0].messages[0].content, /original$/);

  const long = await handleSpin('x'.repeat(13000), 'Custom prompt');
  assert.equal(long.metadata.truncated, true);
  assert.equal(long.metadata.prompt, 'Custom prompt');
});

test('handleReview and handleSummarize wrap the model output', async (t) => {
  mockGroq(t, 'looks good');
  assert.equal((await handleReview('text')).reviewed, 'looks good');
  assert.equal((await handleSummarize('text')).summary, 'looks good');
});

test('handleChat builds context, keeps only the last 8 user/assistant turns, then the new message', async (t) => {
  const calls = mockGroq(t, 'answer');
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  history.push({ role: 'system', content: 'ignored' });
  const out = await handleChat('page content', 'question?', history);

  assert.equal(out.reply, 'answer');
  const sent = calls[0].messages;
  assert.equal(sent[0].role, 'system');
  assert.match(sent[0].content, /page content/);
  assert.equal(sent[sent.length - 1].content, 'question?');
  // history.slice(-8) keeps 7 real turns + the ignored system entry -> 7 turns + system ctx + question
  assert.equal(sent.length, 1 + 7 + 1);
  assert.ok(!sent.some((m) => m.content === 'ignored'));
});

// --- routing ---------------------------------------------------------------------

test('routeToHandler dispatches by intent and defaults to chat', async (t) => {
  mockGroq(t, (messages) => `reply:${messages[messages.length - 1].content.slice(0, 12)}`);
  assert.ok('spun' in (await routeToHandler('spin', 'c', 'm')));
  assert.ok('reviewed' in (await routeToHandler('review', 'c', 'm')));
  assert.ok('summary' in (await routeToHandler('summarize', 'c', 'm')));
  assert.ok('reply' in (await routeToHandler('chat', 'c', 'm')));
  assert.ok('reply' in (await routeToHandler('something-else', 'c', 'm')));
});

// --- /ask end to end (HTTP) ------------------------------------------------------------

async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
  }
}

const ask = (base, body) => fetch(`${base}/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

test('/ask routes a summarize request and reports the route', async (t) => {
  mockGroq(t, 'short summary');
  await withServer(async (base) => {
    const res = await ask(base, { content: 'long page', message: 'summarize it' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      summary: 'short summary',
      metadata: { truncated: false },
      _routed_to: 'summarize'
    });
  });
});

test('/ask maps upstream rate limiting to 429 without leaking details', async (t) => {
  t.mock.method(axios, 'post', async () => { throw httpError(429, 'secret upstream detail'); });
  await withServer(async (base) => {
    const res = await ask(base, { content: 'page', message: 'summarize' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body._routed_to, 'summarize');
    assert.ok(!JSON.stringify(body).includes('secret upstream detail'));
  });
});

test('/ask maps other upstream failures to 502 without leaking details', async (t) => {
  t.mock.method(axios, 'post', async () => { throw httpError(500, 'stack trace here'); });
  await withServer(async (base) => {
    const res = await ask(base, { content: 'page', message: 'summarize' });
    assert.equal(res.status, 502);
    assert.ok(!JSON.stringify(await res.json()).includes('stack trace'));
  });
});
