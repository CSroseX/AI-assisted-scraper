const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.GROQ_API_KEY = 'test-key';

const { clampTextForModel, withRetries, callGroq } = require('./groq');

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
