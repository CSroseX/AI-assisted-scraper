import { act, renderHook } from '@testing-library/react';
import { useSessions } from './useSessions';
import { useNotifications } from './useNotifications';

describe('useSessions', () => {
  test('starts with one session awaiting a URL', () => {
    const { result } = renderHook(() => useSessions());
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.currentSession).toMatchObject({ id: 1, awaitingUrl: true, messages: [] });
  });

  test('addSession creates unique ids and selects the new session', () => {
    const { result } = renderHook(() => useSessions());
    let id2;
    let id3;
    act(() => { id2 = result.current.addSession(); });
    act(() => { id3 = result.current.addSession(); });
    expect([id2, id3]).toEqual([2, 3]);
    expect(result.current.currentSessionId).toBe(3);
    expect(result.current.sessions.map((s) => s.id)).toEqual([1, 2, 3]);
  });

  test('ids are never reused after a delete', () => {
    const { result } = renderHook(() => useSessions());
    act(() => { result.current.addSession(); });
    act(() => { result.current.deleteSession(2); });
    let id;
    act(() => { id = result.current.addSession(); });
    expect(id).toBe(3);
  });

  test('updateSession merges an object or applies an updater to only that session', () => {
    const { result } = renderHook(() => useSessions());
    act(() => { result.current.addSession(); });
    act(() => { result.current.updateSession(1, { url: 'https://a.test' }); });
    act(() => { result.current.updateSession(2, (s) => ({ ...s, title: 'Two' })); });
    expect(result.current.sessions[0]).toMatchObject({ id: 1, url: 'https://a.test', title: '' });
    expect(result.current.sessions[1]).toMatchObject({ id: 2, title: 'Two', url: '' });
  });

  test('deleting the last remaining session is a no-op', () => {
    const { result } = renderHook(() => useSessions());
    act(() => { result.current.deleteSession(1); });
    expect(result.current.sessions).toHaveLength(1);
  });

  test('deleting the current session selects its neighbour', () => {
    const { result } = renderHook(() => useSessions());
    act(() => { result.current.addSession(); });
    act(() => { result.current.addSession(); }); // current = 3
    act(() => { result.current.deleteSession(3); });
    expect(result.current.currentSessionId).toBe(2);
    act(() => { result.current.selectSession(1); });
    act(() => { result.current.deleteSession(1); });
    expect(result.current.currentSessionId).toBe(2);
  });

  test('deleting a non-current session keeps the selection', () => {
    const { result } = renderHook(() => useSessions());
    act(() => { result.current.addSession(); });
    act(() => { result.current.deleteSession(1); });
    expect(result.current.currentSessionId).toBe(2);
    expect(result.current.sessions).toHaveLength(1);
  });
});

describe('useNotifications', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('notify adds to the list without a toast by default', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.notify('hello'));
    expect(result.current.notifications).toEqual(['hello']);
    expect(result.current.toast).toBeNull();
  });

  test('a toast appears and clears itself after two seconds', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.notify('saved', { toast: true }));
    expect(result.current.toast).toBe('saved');
    act(() => jest.advanceTimersByTime(1999));
    expect(result.current.toast).toBe('saved');
    act(() => jest.advanceTimersByTime(2));
    expect(result.current.toast).toBeNull();
  });

  test('a newer toast replaces the older one and restarts the timer', () => {
    const { result } = renderHook(() => useNotifications());
    act(() => result.current.notify('first', { toast: true }));
    act(() => jest.advanceTimersByTime(1500));
    act(() => result.current.notify('second', { toast: true }));
    act(() => jest.advanceTimersByTime(1500));
    expect(result.current.toast).toBe('second');
    act(() => jest.advanceTimersByTime(600));
    expect(result.current.toast).toBeNull();
    expect(result.current.notifications).toEqual(['first', 'second']);
  });
});
