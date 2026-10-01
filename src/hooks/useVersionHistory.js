import { useCallback, useEffect, useState } from 'react';
import { fetchVersionHistory } from '../api/client';
import { toVersionList } from '../utils/messages';

export function useVersionHistory() {
  const [versionHistory, setVersionHistory] = useState([]);

  const refresh = useCallback(async () => {
    try {
      setVersionHistory(toVersionList(await fetchVersionHistory()));
    } catch (_) {
      setVersionHistory([]);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { versionHistory, refresh };
}
