import {
  checkWatch, clearFeedback, createWatch, deleteWatch, getSnapshot, listAlerts, listChanges,
  listWatches, setFeedback, snapshotScreenshotUrl, updateWatch
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

  test('createWatch sends the chosen selector and alert channels', async () => {
    const fetchMock = mockFetch(ok({ id: 7 }));
    await createWatch('https://a.test/pricing', 'weekly', 'main', ['email', 'rss']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      url: 'https://a.test/pricing', frequency: 'weekly', selector: 'main', alertChannels: ['email', 'rss']
    });
  });

  test('updateWatch PATCHes the watch with only the given fields', async () => {
    const fetchMock = mockFetch(ok({ id: 7, status: 'paused' }));
    await expect(updateWatch(7, { status: 'paused' })).resolves.toEqual({ id: 7, status: 'paused' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/watches\/7$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'paused' });
  });

  test('deleteWatch sends DELETE and accepts an empty 204 reply', async () => {
    const fetchMock = mockFetch({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    await expect(deleteWatch(7)).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/watches\/7$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');

    mockFetch(fail({ error: 'Watch not found' }));
    await expect(deleteWatch(99)).rejects.toThrow('Watch not found');
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

  test('listAlerts and getSnapshot GET their routes', async () => {
    const fetchMock = mockFetch(ok([]));
    await listAlerts(7);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/watches\/7\/alerts$/);
    mockFetch(ok({ id: 3, content: 'text' }));
    await expect(getSnapshot(7, 3)).resolves.toEqual({ id: 3, content: 'text' });
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/watches\/7\/snapshots\/3$/);
  });

  test('snapshotScreenshotUrl carries no token', () => {
    const url = snapshotScreenshotUrl(7, 3);
    expect(url).toMatch(/\/watches\/7\/snapshots\/3\/screenshot$/);
    expect(url).not.toMatch(/token/);
  });

  test('setFeedback PUTs the vote and clearFeedback DELETEs it', async () => {
    const fetchMock = mockFetch(ok({ changeId: 3, vote: 'noise' }));
    await setFeedback(7, 3, 'noise');
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/watches\/7\/changes\/3\/feedback$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ vote: 'noise' });

    mockFetch({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    await expect(clearFeedback(7, 3)).resolves.toBeNull();
    expect(global.fetch.mock.calls[0][1].method).toBe('DELETE');
  });

  test('surfaces backend error messages', async () => {
    mockFetch(fail({ error: 'Watch not found' }));
    await expect(listChanges(99)).rejects.toThrow('Watch not found');
    mockFetch(fail({}, true));
    await expect(listWatches()).rejects.toThrow('Could not load watches');
  });
});
