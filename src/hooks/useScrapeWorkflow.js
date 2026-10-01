import { useState } from 'react';
import { askWithRouting, reviewContent, saveVersion, scrapeUrl, spinText } from '../api/client';
import { reportError } from '../utils/errors';
import { isValidUrl } from '../utils/url';
import { LOADER_TEXT, replaceTrailingLoader, reviewedMessage } from '../utils/messages';

const THINKING = 'Thinking...';

// Runs an API call, reporting failures to the user and resolving to null.
async function attempt(promise) {
  try {
    return await promise;
  } catch (err) {
    reportError(err);
    return null;
  }
}

// Orchestrates scrape -> AI Writer (spin) -> AI Reviewer, plus edits and chat.
export function useScrapeWorkflow({ currentSession, currentSessionId, updateSession, refreshVersions, setCurrentReviewId, resetFeedback, notify }) {
  const [loading, setLoading] = useState(false);

  const showReview = (id, review) => {
    setCurrentReviewId(review.reviewId || null);
    updateSession(id, (s) => ({ ...s, messages: [...s.messages, reviewedMessage(review)] }));
  };

  const submitUrl = async (url) => {
    const id = currentSessionId;
    resetFeedback();
    updateSession(id, {
      url,
      awaitingUrl: false,
      messages: [
        { role: 'user', content: url },
        { role: 'assistant', content: 'URL accepted.' },
        { role: 'assistant', content: LOADER_TEXT.writer, type: 'loader' }
      ]
    });

    setLoading(true);
    const scraped = await attempt(scrapeUrl(url));
    setLoading(false);

    if (!scraped) {
      updateSession(id, {
        messages: [
          { role: 'user', content: url },
          { role: 'assistant', content: 'Failed to scrape the URL.' }
        ]
      });
      return;
    }

    updateSession(id, { scrapedContent: scraped.content, screenshotPath: scraped.screenshotPath });

    const spun = await attempt(spinText(scraped.content));
    const spunText = spun?.spun;
    updateSession(id, (s) => ({
      ...s,
      messages: s.messages.map((m) => {
        if (m.type !== 'loader') return m;
        return spunText
          ? { role: 'assistant', content: spunText, type: 'spunContent' }
          : { role: 'assistant', content: 'Failed to spin content.' };
      })
    }));
    if (!spunText) return;

    // Only the AI Writer output is stored as a version at this stage.
    await attempt(saveVersion(spunText, null, 'ai-writer'));
    await refreshVersions();

    const review = await attempt(reviewContent(spunText));
    if (review?.reviewed) showReview(id, review);
  };

  // User edited the AI Writer output: store it, then re-run the reviewer on it.
  const editWriter = async (newContent) => {
    const id = currentSessionId;
    const version = await attempt(saveVersion(newContent, null, 'ai-writer'));
    if (!version) return;

    updateSession(id, (s) => ({
      ...s,
      scrapedContent: newContent,
      messages: [
        ...s.messages
          .map((m) => (m.type === 'spunContent' ? { ...m, content: newContent } : m))
          .filter((m) => m.type !== 'reviewedContent'),
        { role: 'assistant', content: LOADER_TEXT.reviewer, type: 'loader' }
      ]
    }));

    const review = await attempt(reviewContent(newContent));
    setCurrentReviewId(review?.reviewId || null);
    updateSession(id, (s) => ({
      ...s,
      messages: replaceTrailingLoader(
        s.messages,
        LOADER_TEXT.reviewer,
        review?.reviewed ? reviewedMessage(review) : { role: 'assistant', content: 'AI Reviewer failed to reply.' }
      )
    }));
    await refreshVersions();
  };

  const sendMessage = async (text) => {
    if (!currentSession) return;
    const id = currentSessionId;
    const userMsg = { role: 'user', content: text };
    const append = (...msgs) => updateSession(id, (s) => ({ ...s, messages: [...s.messages, ...msgs] }));

    // Normally unreachable because the URL modal blocks input, but stay safe.
    if (currentSession.awaitingUrl) {
      if (isValidUrl(text)) {
        updateSession(id, {
          url: text,
          awaitingUrl: false,
          messages: [userMsg, { role: 'assistant', content: 'URL received! How can I help you with this page?' }]
        });
      } else {
        append(userMsg, { role: 'assistant', content: 'Please insert a URL' });
      }
      return;
    }

    const context = currentSession.scrapedContent || '';
    if (!context.trim()) {
      append(userMsg, { role: 'assistant', content: 'No scraped content is available yet. Please submit a URL first.' });
      return;
    }

    append(userMsg, { role: 'assistant', content: THINKING });
    const history = currentSession.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const result = await attempt(askWithRouting(context, history, text));

    updateSession(id, (s) => ({
      ...s,
      messages: replaceTrailingLoader(s.messages, THINKING, {
        role: 'assistant',
        content: result?.text || 'AI failed to reply.',
        route: result?.routedTo || 'chat'
      })
    }));
    if (result?.routedTo) notify(`Routed to: ${result.routedTo}`);
  };

  return { loading, submitUrl, editWriter, sendMessage };
}
