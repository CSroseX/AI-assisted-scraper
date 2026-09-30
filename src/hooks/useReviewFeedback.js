import { useCallback, useEffect, useRef, useState } from 'react';
import { sendFeedback } from '../api/client';

const ANIM_MS = 400;

const MESSAGES = {
  up: 'Marked as helpful — the AI will learn from this!',
  down: 'Marked as unhelpful — we’ll use this to improve.'
};

// Thumbs up/down on the latest review, reported to the RL backend.
export function useReviewFeedback({ notify }) {
  const [thumbAnim, setThumbAnim] = useState(null); // 'up' | 'down' | null
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [currentReviewId, setCurrentReviewId] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const submit = useCallback(async (direction) => {
    setThumbAnim(direction);
    notify(MESSAGES[direction], { toast: true });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setThumbAnim(null), ANIM_MS);
    setFeedbackSubmitted(true);
    try {
      await sendFeedback(direction === 'up' ? 1 : -1, currentReviewId);
    } catch (_) {
      notify('Could not send feedback to the review service.', { toast: true });
    }
  }, [notify, currentReviewId]);

  const resetFeedback = useCallback(() => setFeedbackSubmitted(false), []);

  return {
    thumbAnim,
    feedbackSubmitted,
    setCurrentReviewId,
    resetFeedback,
    onThumbUp: () => submit('up'),
    onThumbDown: () => submit('down')
  };
}
