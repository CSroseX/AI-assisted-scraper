import { askWithRouting, checkWatch, createWatch, listChanges, listWatches, scrapeUrl, spinText } from './client';

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

describe('spinText', () => {
  test('sends the default prompt unless overridden', async () => {
    const fetchMock = mockFetch(ok({ spun: 's' }));
    await spinText('hello');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toMatch(/Rewrite in modern English/);
    await spinText('hello', 'custom');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toBe('custom');
  });

  test('failures surface as errors', async () => {
    mockFetch(fail({}));
    await expect(spinText('x')).rejects.toThrow('Spin failed');
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

describe('watches', () => {
  test('listWatches GETs /watches', async () => {
    const fetchMock = mockFetch(ok([{ id: 1, url: 'https://a.test' }]));
    await expect(listWatches()).resolves.toEqual([{ id: 1, url: 'https://a.test' }]);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/watches$/);
    // A GET must not carry a body or a method override.
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  test('createWatch posts the url with a default daily frequency', async () => {
    const fetchMock = mockFetch(ok({ id: 7 }));
    await createWatch('https://a.test/pricing');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      url: 'https://a.test/pricing', frequency: 'daily', selector: null
    });
  });

  test('checkWatch posts to the watch check route', async () => {
    const fetchMock = mockFetch(ok({ changed: false }));
    await checkWatch(7);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/watches\/7\/check$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  test('listChanges returns changes with their explanations', async () => {
    mockFetch(ok([{ id: 3, category: 'price', summary: 'Up by $2.', quotes: ['Price: $12/month.'] }]));
    const changes = await listChanges(7);
    expect(changes[0].summary).toBe('Up by $2.');
    expect(changes[0].quotes).toEqual(['Price: $12/month.']);
  });

  test('surfaces backend error messages', async () => {
    mockFetch(fail({ error: 'Watch not found' }));
    await expect(listChanges(99)).rejects.toThrow('Watch not found');
    mockFetch(fail({}, true));
    await expect(listWatches()).rejects.toThrow('Could not load watches');
  });
});
