import { useCallback, useEffect, useRef, useState } from 'react';

const TOAST_MS = 2000;

// `notifications` feeds the bell dropdown; `toast` is a short-lived banner.
export function useNotifications() {
  const [notifications, setNotifications] = useState([]);
  const [toast, setToast] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const notify = useCallback((message, { toast: showToast = false } = {}) => {
    setNotifications((n) => [...n, message]);
    if (showToast) {
      setToast(message);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), TOAST_MS);
    }
  }, []);

  return { notifications, toast, notify };
}
