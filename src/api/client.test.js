import {
  askWithRouting,
  fetchVersionHistory,
  reviewContent,
  saveVersion,
  scrapeUrl,
  sendFeedback,
  spinText
} from './client';

function mockFetch(response) {
  global.fetch = jest.fn().mockResolvedValue(response);
  return global.fetch;
}

const ok = (data) => ({ ok: true, json: async () => data });
const fail = (data, jsonThrows = false) => ({
  ok: false,
  json: jsonThrows ? async () => { throw new Error('not json'); } : async () => data
});

afterEach(() => {
  delete global.fetch;
});

describe('scrapeUrl', () => {
  test('posts the url and returns the payload', async () => {
    const fetchMock = mockFetch(ok({ content: 'text', screenshotPath: 'screenshots/a.png' }));
    await expect(scrapeUrl('https://example.com')).resolves.toEqual({ content: 'text', screenshotPath: 'screenshots/a.png' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/scrape$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://example.com' });
  });

  test('throws the backend error message', async () => {
    mockFetch(fail({ error: 'Only http and https URLs are allowed' }));
    await expect(scrapeUrl('ftp://x')).rejects.toThrow('Only http and https URLs are allowed');
  });

  test('falls back to a generic message when the body is not JSON', async () => {
    mockFetch(fail(null, true));
    await expect(scrapeUrl('https://x.test')).rejects.toThrow('Scraping failed');
  });
});

describe('spinText / saveVersion / reviewContent', () => {
  test('spinText sends the default prompt unless overridden', async () => {
    const fetchMock = mockFetch(ok({ spun: 's' }));
    await spinText('hello');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toMatch(/Rewrite in modern English/);
    await spinText('hello', 'custom');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toBe('custom');
  });

  test('saveVersion posts content, parent and editor', async () => {
    const fetchMock = mockFetch(ok({ id: 'v1' }));
    await saveVersion('c', null, 'ai-writer');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ content: 'c', parent_version: null, editor: 'ai-writer' });
  });

  test('reviewContent maps snake_case fields', async () => {
    mockFetch(ok({ reviewed: 'r', review_id: 'id1', action: 0 }));
    await expect(reviewContent('x')).resolves.toEqual({ reviewed: 'r', reviewId: 'id1', action: 0 });
  });

  test('failures surface as errors', async () => {
    mockFetch(fail({}));
    await expect(spinText('x')).rejects.toThrow('Spin failed');
    await expect(saveVersion('x')).rejects.toThrow('Save version failed');
    await expect(reviewContent('x')).rejects.toThrow('Review failed');
  });
});

describe('fetchVersionHistory', () => {
  test('returns the raw payload and throws on failure', async () => {
    mockFetch(ok({ ids: [] }));
    await expect(fetchVersionHistory()).resolves.toEqual({ ids: [] });
    mockFetch(fail({}));
    await expect(fetchVersionHistory()).rejects.toThrow('Failed to fetch version history');
  });
});

describe('askWithRouting', () => {
  test.each([
    [{ _routed_to: 'chat', reply: 'r' }, 'r', 'chat'],
    [{ _routed_to: 'spin', spun: 's' }, 's', 'spin'],
    [{ _routed_to: 'review', reviewed: 'v' }, 'v', 'review'],
    [{ _routed_to: 'summarize', summary: 'm' }, 'm', 'summarize']
  ])('picks the field for the routed intent %j', async (payload, text, routedTo) => {
    mockFetch(ok(payload));
    await expect(askWithRouting('c', [], 'q')).resolves.toEqual({ text, routedTo });
  });

  test('falls back to any available field, then to a default message', async () => {
    mockFetch(ok({ _routed_to: 'summarize', reply: 'fallback' }));
    await expect(askWithRouting('c', [], 'q')).resolves.toEqual({ text: 'fallback', routedTo: 'summarize' });
    mockFetch(ok({}));
    await expect(askWithRouting('c', [], 'q')).resolves.toEqual({ text: 'AI failed to reply.', routedTo: 'chat' });
  });

  test('sends content, history and message; throws backend errors', async () => {
    const fetchMock = mockFetch(ok({ reply: 'x' }));
    await askWithRouting('ctx', [{ role: 'user', content: 'a' }], 'q');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      content: 'ctx', history: [{ role: 'user', content: 'a' }], message: 'q'
    });
    mockFetch(fail({ error: 'Too many requests' }));
    await expect(askWithRouting('c', [], 'q')).rejects.toThrow('Too many requests');
  });
});

describe('sendFeedback', () => {
  test('posts reward and review id', async () => {
    const fetchMock = mockFetch(ok({}));
    await sendFeedback(-1, 'r1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reward: -1, review_id: 'r1' });
  });

  test('throws when the service rejects it', async () => {
    mockFetch(fail({}));
    await expect(sendFeedback(1, 'r1')).rejects.toThrow('Feedback failed');
  });
});
