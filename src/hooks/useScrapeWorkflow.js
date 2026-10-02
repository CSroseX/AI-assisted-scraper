import { useState } from 'react';
import { askWithRouting, scrapeUrl, spinText } from '../api/client';
import { reportError } from '../utils/errors';
import { isValidUrl } from '../utils/url';
import { LOADER_TEXT, replaceTrailingLoader } from '../utils/messages';

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

// Orchestrates scrape -> AI Writer (spin), plus edits and chat.
export function useScrapeWorkflow({ currentSession, currentSessionId, updateSession, notify }) {
  const [loading, setLoading] = useState(false);

  const submitUrl = async (url) => {
    const id = currentSessionId;
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
  };

  // User edited the AI Writer output in place.
  const editWriter = async (newContent) => {
    const id = currentSessionId;
    updateSession(id, (s) => ({
      ...s,
      scrapedContent: newContent,
      messages: s.messages.map((m) => (m.type === 'spunContent' ? { ...m, content: newContent } : m))
    }));
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
