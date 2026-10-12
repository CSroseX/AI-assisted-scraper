import { act, renderHook } from '@testing-library/react';
import { useWatchCheck } from './useWatchCheck';
import * as client from '../api/client';

// Drives the hook against a mutable session object, the way App does.
function setup(session = { id: 1, url: 'https://a.test/pricing', messages: [] }) {
  const state = { ...session };
  const notify = jest.fn();
  const updateSession = jest.fn((id, changes) => {
    Object.assign(state, typeof changes === 'function' ? changes(state) : changes);
  });

  const view = renderHook(() => useWatchCheck({
    currentSession: state,
    currentSessionId: state.id,
    updateSession,
    notify
  }));

  return { view, state, notify, updateSession };
}

const lastMessage = (state) => state.messages[state.messages.length - 1];

afterEach(() => {
  jest.restoreAllMocks();
});

test('creates a watch once, then reuses it on later checks', async () => {
  const createWatch = jest.spyOn(client, 'createWatch').mockResolvedValue({ id: 42 });
  jest.spyOn(client, 'checkWatch').mockResolvedValue({ changed: true, change: null });

  const { view, state } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });
  expect(createWatch).toHaveBeenCalledWith('https://a.test/pricing');
  expect(state.watchId).toBe(42);

  await act(async () => { await view.result.current.checkForChanges(); });
  expect(createWatch).toHaveBeenCalledTimes(1);
});

test('a first check reports a saved baseline, not a change', async () => {
  jest.spyOn(client, 'createWatch').mockResolvedValue({ id: 1 });
  jest.spyOn(client, 'checkWatch').mockResolvedValue({ changed: true, change: null });
  const listChanges = jest.spyOn(client, 'listChanges');

  const { view, state } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });

  expect(lastMessage(state).content).toMatch(/baseline saved/i);
  expect(listChanges).not.toHaveBeenCalled();
});

test('an unchanged page says so', async () => {
  jest.spyOn(client, 'createWatch').mockResolvedValue({ id: 1 });
  jest.spyOn(client, 'checkWatch').mockResolvedValue({ changed: false, change: null });

  const { view, state } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });
  expect(lastMessage(state).content).toMatch(/no changes/i);
});

test('a detected change becomes a changeExplanation message and notifies', async () => {
  const change = {
    id: 9,
    category: 'price',
    summary: 'The monthly price rose from $10 to $12.',
    quotes: ['Price: $10/month.', 'Price: $12/month.']
  };
  jest.spyOn(client, 'createWatch').mockResolvedValue({ id: 1 });
  jest.spyOn(client, 'checkWatch').mockResolvedValue({ changed: true, change: { id: 9 } });
  jest.spyOn(client, 'listChanges').mockResolvedValue([change]);

  const { view, state, notify } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });

  const msg = lastMessage(state);
  expect(msg.type).toBe('changeExplanation');
  expect(msg.content).toBe('The monthly price rose from $10 to $12.');
  expect(msg.change).toEqual(change);
  expect(notify).toHaveBeenCalledWith('A change was detected on this page', { toast: true });
});

test('an unexplained change still reports that the page changed', async () => {
  jest.spyOn(client, 'createWatch').mockResolvedValue({ id: 1 });
  jest.spyOn(client, 'checkWatch').mockResolvedValue({ changed: true, change: { id: 9 } });
  jest.spyOn(client, 'listChanges').mockResolvedValue([{ id: 9, summary: null, quotes: [] }]);

  const { view, state } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });
  expect(lastMessage(state).content).toBe('This page changed.');
});

test('a failure reads as an explanation in the chat, not an alert', async () => {
  jest.spyOn(client, 'createWatch').mockRejectedValue(new Error('Login required to read this page'));

  const { view, state } = setup();
  await act(async () => { await view.result.current.checkForChanges(); });

  expect(lastMessage(state).content).toMatch(/could not check this page: login required/i);
  expect(view.result.current.checking).toBe(false);
});

test('does nothing without a URL', async () => {
  const checkWatch = jest.spyOn(client, 'checkWatch');
  const { view } = setup({ id: 1, url: '', messages: [] });
  await act(async () => { await view.result.current.checkForChanges(); });
  expect(checkWatch).not.toHaveBeenCalled();
});
