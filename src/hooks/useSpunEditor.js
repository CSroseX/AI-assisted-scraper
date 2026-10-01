import { useCallback, useState } from 'react';

// Inline editing state for the AI Writer output.
export function useSpunEditor(spunMsg) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  const start = useCallback(() => {
    setValue(spunMsg ? spunMsg.content : '');
    setEditing(true);
  }, [spunMsg]);

  const stop = useCallback(() => setEditing(false), []);

  return { editing, value, setValue, start, stop };
}
