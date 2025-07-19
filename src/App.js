import React, { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import Chat from './Chat';
import UrlModal from './UrlModal';
import './App.css';
import { FaBell } from 'react-icons/fa';

function getDefaultSession(id) {
  return {
    id,
    title: '',
    url: '',
    messages: [],
    awaitingUrl: true
  };
}

// Add this function inside your App.js or a relevant component
const scrapeUrl = async (url) => {
  try {
    const res = await fetch('http://localhost:5000/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error('Scraping failed');
    const data = await res.json();
    // data.content: the scraped text
    // data.screenshotPath: the path to the screenshot on the backend
    return data;
  } catch (err) {
    alert('Error: ' + err.message);
    return null;
  }
};

const spinText = async (text, prompt = "Rewrite in modern English and simplify the tone. Remove any special characters and numbers. Re-write the content in a way that is easy to understand and follow. Do not format the content in any way.") => {
  try {
    const res = await fetch('http://localhost:5000/spin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, prompt }),
    });
    if (!res.ok) throw new Error('Spin failed');
    const data = await res.json();
    return data;
  } catch (err) {
    alert('Error: ' + err.message);
    return null;
  }
};

// Add version to ChromaDB via backend
const saveVersion = async (content, parent_version, editor = "user") => {
  try {
    const res = await fetch('http://localhost:5000/version', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, parent_version, editor }),
    });
    if (!res.ok) throw new Error('Save version failed');
    return await res.json();
  } catch (err) {
    alert('Error: ' + err.message);
    return null;
  }
};

// Fetch version history from backend
const fetchVersionHistory = async () => {
  try {
    const res = await fetch('http://localhost:5000/version/history');
    if (!res.ok) throw new Error('Failed to fetch version history');
    const data = await res.json();
    // Transform ChromaDB raw result to array of version objects
    if (data.ids && data.metadatas && data.documents) {
      return data.ids.map((id, i) => ({
        id,
        parent_version: data.metadatas[i]?.parent_version || "",
        content: data.documents[i] || "",
        timestamp: data.metadatas[i]?.timestamp || 0,
        editor: data.metadatas[i]?.editor || "user"
      }));
    }
    return [];
  } catch (err) {
    return [];
  }
};

// Helper to call /chat endpoint for contextual AI
const chatWithAI = async (context, history, userMessage) => {
  try {
    const res = await fetch('http://localhost:5000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, history, userMessage }),
    });
    if (!res.ok) throw new Error('Chat failed');
    const data = await res.json();
    return data.reply;
  } catch (err) {
    alert('Error: ' + err.message);
    return null;
  }
};

// Helper to call RL-based /review endpoint for AI Reviewer
const reviewContent = async (spunContent) => {
  try {
    const res = await fetch('http://localhost:5050/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spunContent }),
    });
    if (!res.ok) throw new Error('Review failed');
    const data = await res.json();
    return data.reviewed;
  } catch (err) {
    alert('Error: ' + err.message);
    return null;
  }
};

function App() {
  const [sessions, setSessions] = useState([
    getDefaultSession(1)
  ]);
  const [currentSessionId, setCurrentSessionId] = useState(1);
  const [showUrlModal, setShowUrlModal] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState(null);
  const [loading, setLoading] = useState(false); // NEW: loading state
  const [showScreenshotModal, setShowScreenshotModal] = useState(false); // modal state
  const [showScrapedData, setShowScrapedData] = useState(false); // NEW: show scraped data
  const [spunContent, setSpunContent] = useState(null); // NEW: spun content
  const [showScrapedDataModal, setShowScrapedDataModal] = useState(false); // NEW: modal for scraped data
  const [editMode, setEditMode] = useState(false); // NEW: edit mode for spun content
  const [editValue, setEditValue] = useState(''); // NEW: edit value
  const [lastSavedVersion, setLastSavedVersion] = useState(null); // NEW: last saved version object
  const [versionHistory, setVersionHistory] = useState([]); // version history
  const [showVersionHistoryModal, setShowVersionHistoryModal] = useState(false); // version history modal
  const [expandedVersion, setExpandedVersion] = useState(null); // expanded version id
  // Feedback state for latest reviewed content
  const [feedback, setFeedback] = useState('');
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [notification, setNotification] = useState(null);
  const [thumbAnim, setThumbAnim] = useState(null); // 'up' or 'down' or null
  const [input, setInput] = useState('');
  const [notifications, setNotifications] = useState([]); // for bell icon
  const [showNotifDropdown, setShowNotifDropdown] = useState(false);

  const currentSession = sessions.find(s => s.id === currentSessionId);

  // Show modal for Chat 1 on first load if awaitingUrl is true
  useEffect(() => {
    if (currentSession && currentSession.awaitingUrl) {
      setPendingSessionId(currentSession.id);
      setShowUrlModal(true);
    }
  }, [currentSession]);

  function isValidUrl(str) {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  const handleSendMessage = async (text) => {
    if (!currentSession) return;
    if (currentSession.awaitingUrl) {
      // Should not happen, as modal blocks input, but fallback
      if (isValidUrl(text)) {
        setSessions(sessions => sessions.map(session =>
          session.id === currentSessionId
            ? {
                ...session,
                url: text,
                awaitingUrl: false,
                messages: [
                  { role: 'user', content: text },
                  { role: 'assistant', content: 'URL received! How can I help you with this page?' }
                ]
              }
            : session
        ));
      } else {
        setSessions(sessions => sessions.map(session =>
          session.id === currentSessionId
            ? {
                ...session,
                messages: [...session.messages, { role: 'user', content: text }, { role: 'assistant', content: 'Please insert a URL' }]
              }
            : session
        ));
      }
    } else {
      // Real-time AI chat with context
      const userMsg = { role: 'user', content: text };
      setSessions(sessions => sessions.map(session =>
        session.id === currentSessionId
          ? { ...session, messages: [...session.messages, userMsg, { role: 'assistant', content: 'Thinking...' }] }
          : session
      ));
      // Gather context and history
      const context = currentSession.scrapedContent || '';
      const history = currentSession.messages.filter(m => m.role === 'user' || m.role === 'assistant');
      const aiReply = await chatWithAI(context, history, text);
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        // Replace the last 'Thinking...' message with the AI reply
        const msgs = [...session.messages];
        if (msgs.length && msgs[msgs.length - 1].content === 'Thinking...') {
          msgs[msgs.length - 1] = { role: 'assistant', content: aiReply || 'AI failed to reply.' };
        }
        return { ...session, messages: msgs };
      }));
    }
  };

  const handleSelectSession = (id) => {
    setCurrentSessionId(id);
  };

  const handleNewChat = () => {
    const newId = sessions.length ? Math.max(...sessions.map(s => s.id)) + 1 : 1;
    setSessions([...sessions, getDefaultSession(newId)]);
    setCurrentSessionId(newId);
    setPendingSessionId(newId);
    setShowUrlModal(true);
  };

  const handleDeleteSession = (id) => {
    if (sessions.length === 1) return;
    const idx = sessions.findIndex(s => s.id === id);
    const newSessions = sessions.filter(s => s.id !== id);
    setSessions(newSessions);
    if (currentSessionId === id) {
      const newIdx = idx > 0 ? idx - 1 : 0;
      setCurrentSessionId(newSessions[newIdx].id);
    }
  };

  // UPDATED: handleUrlSubmit for AI Writer/Reviewer workflow
  const handleUrlSubmit = async (url) => {
    setShowUrlModal(false);
    setPendingSessionId(null);
    setShowScrapedDataModal(false);
    setSpunContent(null);
    setFeedback('');
    setFeedbackSubmitted(false);
    // Add 'URL accepted.' and loader messages
    let newMessages = [
      { role: 'user', content: url },
      { role: 'assistant', content: 'URL accepted.' },
      { role: 'assistant', content: 'AI Writer is spinning the content...', type: 'loader' }
    ];
    setSessions(sessions => sessions.map(session =>
      session.id === currentSessionId
        ? { ...session, url, awaitingUrl: false, messages: newMessages }
        : session
    ));
    setLoading(true);
    const result = await scrapeUrl(url);
    setLoading(false);
    if (result) {
      setSessions(sessions => sessions.map(session =>
        session.id === currentSessionId
        ? {
            ...session,
            url,
            awaitingUrl: false,
              scrapedContent: result.content,
              screenshotPath: result.screenshotPath,
              messages: session.messages // keep current messages
            }
          : session
      ));
      // AI Writer: Spin the scraped content
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        const msgs = session.messages.map(m =>
          m.type === 'loader' ? { role: 'assistant', content: 'AI Writer is spinning the content...', type: 'loader' } : m
        );
        return { ...session, messages: msgs };
      }));
      const spinResult = await spinText(result.content);
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        // Replace loader with spun content
        const msgs = session.messages.map(m =>
          m.type === 'loader' ? (spinResult && spinResult.spun ? { role: 'assistant', content: spinResult.spun, type: 'spunContent' } : { role: 'assistant', content: 'Failed to spin content.' }) : m
        );
        return { ...session, messages: msgs };
      }));
      // In handleUrlSubmit, only save the spunContent as a version with editor: 'ai-writer'
      if (spinResult && spinResult.spun) {
        await saveVersion(spinResult.spun, null, 'ai-writer');
        const history = await fetchVersionHistory();
        setVersionHistory(history);
      }
      // AI Reviewer: Refine the spun content (do not add to chat)
      await reviewContent(spinResult.spun);
    } else {
      setSessions(sessions => sessions.map(session =>
        session.id === currentSessionId
          ? {
              ...session,
            messages: [
              { role: 'user', content: url },
                { role: 'assistant', content: 'Failed to scrape the URL.' }
            ]
          }
        : session
    ));
    }
  };

  // When user clicks 'See Scraped Data', just show the modal
  const handleShowScrapedData = () => {
    setShowScrapedDataModal(true);
  };

  // When scraped data modal is closed, do nothing
  const handleCloseScrapedDataModal = () => {
    setShowScrapedDataModal(false);
  };

  // Only show modal if current session is awaiting URL
  const shouldShowModal = showUrlModal;

  // Find the latest spun content message and its index (from the end, not just first occurrence)
  const spunMsgIndex = (() => {
    if (!currentSession?.messages) return -1;
    for (let i = currentSession.messages.length - 1; i >= 0; i--) {
      if (currentSession.messages[i].type === 'spunContent') return currentSession.messages.length - 1 - i;
    }
    return -1;
  })();
  const spunMsg = spunMsgIndex !== -1 && spunMsgIndex !== undefined
    ? currentSession?.messages[currentSession.messages.length - 1 - spunMsgIndex]
    : null;

  // Find the previous version id (if any)
  const prevVersionId = lastSavedVersion?.id || null;

  // Handler for edit button (now for spunContent)
  const handleEditSpun = () => {
    setEditValue(spunMsg.content);
    setEditMode(true);
    setLastSavedVersion(lastSavedVersion || { content: spunMsg.content });
  };

  // Handler for cancel
  const handleCancelEdit = () => {
    setEditMode(false);
    setEditValue('');
  };

  // Handler for save (now for spunContent)
  const handleSaveEdit = async () => {
    if (!editValue || editValue === spunMsg.content) return;
    // Save to ChromaDB
    const version = await saveVersion(editValue, prevVersionId, 'user');
    if (version) {
      setLastSavedVersion(version);
      // Replace the spun message in chat with the new version
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        const msgs = session.messages.map((m, i) =>
          i === (currentSession.messages.length - 1 - spunMsgIndex)
            ? { ...m, content: editValue }
            : m
        );
        return { ...session, messages: msgs };
      }));
      setEditMode(false);
      setEditValue('');
      // Fetch and update version history
      const history = await fetchVersionHistory();
      setVersionHistory(history);
    }
  };

  // Handler for edit/save on AI Writer output (spunContent)
  const handleEditWriter = async (newContent) => {
    // Save edited version
    const version = await saveVersion(newContent, null, 'ai-writer');
    if (version) {
      setLastSavedVersion(version);
      // Update context and rerun reviewer
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        // Replace spun content with edited version
        const msgs = session.messages.map(m =>
          m.type === 'spunContent' ? { ...m, content: newContent } : m
        );
        // Remove any existing reviewedContent
        const filteredMsgs = msgs.filter(m => m.type !== 'reviewedContent');
        // Add reviewer loader
        filteredMsgs.push({ role: 'assistant', content: 'AI Reviewer is refining the content...', type: 'loader' });
        return { ...session, messages: filteredMsgs, scrapedContent: newContent };
      }));
      // AI Reviewer: Refine the edited content
      await reviewContent(newContent); // Do not add to chat
      // Save edited version only (not reviewer output)
      const history = await fetchVersionHistory();
      setVersionHistory(history);
    }
  };

  // Handler for feedback submit (triggers reviewer refinement)
  const handleFeedbackSubmit = async () => {
    setFeedbackSubmitted(true);
    // Find latest reviewed content
    const lastMsg = currentSession.messages[currentSession.messages.length - 1];
    if (lastMsg.type === 'reviewedContent') {
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        // Add reviewer loader
        const msgs = [...session.messages, { role: 'assistant', content: 'AI Reviewer is refining the content...', type: 'loader' }];
        return { ...session, messages: msgs };
      }));
      // Send feedback as reward to RL backend (always 1 for demo)
      await fetch('http://localhost:5050/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reward: 1 }),
      });
      // Reviewer refines based on feedback
      const reviewed = await reviewContent(lastMsg.content + '\n\nUser feedback: ' + feedback);
      setSessions(sessions => sessions.map(session => {
        if (session.id !== currentSessionId) return session;
        // Replace reviewer loader with reviewed content
        const msgs = [...session.messages];
        if (msgs.length && msgs[msgs.length - 1].content === 'AI Reviewer is refining the content...') {
          msgs[msgs.length - 1] = { role: 'assistant', content: reviewed || 'AI Reviewer failed to reply.', type: 'reviewedContent' };
        }
        return { ...session, messages: msgs };
      }));
      // Save reviewed content as a version
      if (reviewed) {
        await saveVersion(reviewed, null, 'ai-reviewer');
        const history = await fetchVersionHistory();
        setVersionHistory(history);
      }
      setFeedback('');
      setTimeout(() => setFeedbackSubmitted(false), 1000);
    }
  };

  // Fetch version history on mount and after each save
  useEffect(() => {
    fetchVersionHistory().then(setVersionHistory);
  }, []);

  return (
    <div className="app-layout">
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
      />
      <div className="main-area" style={{ filter: shouldShowModal ? 'blur(2px)' : 'none', pointerEvents: shouldShowModal ? 'none' : 'auto' }}>
        <div className="chat-header">
          <button onClick={handleNewChat}>+ New Chat</button>
          <h1>AI Assisted scraper</h1>
          <div style={{ position: 'relative', marginLeft: 16 }}>
            <FaBell
              style={{ fontSize: 24, cursor: 'pointer', color: notifications.length ? '#10a37f' : '#888' }}
              onClick={() => setShowNotifDropdown(v => !v)}
              title="Show notifications"
            />
            {showNotifDropdown && (
              <div style={{ position: 'absolute', top: 32, right: 0, background: '#fff', color: '#222', border: '1px solid #eee', borderRadius: 8, minWidth: 260, boxShadow: '0 2px 12px rgba(0,0,0,0.12)', zIndex: 10000 }}>
                <div style={{ padding: 12, borderBottom: '1px solid #eee', fontWeight: 600 }}>Notifications</div>
                {notifications.length === 0 && <div style={{ padding: 16, color: '#888' }}>No notifications yet.</div>}
                {notifications.slice(-5).reverse().map((n, i) => (
                  <div key={i} style={{ padding: 12, borderBottom: i < notifications.length - 1 ? '1px solid #eee' : 'none', fontSize: '1em' }}>{n}</div>
                ))}
              </div>
            )}
          </div>
        </div>
        {loading && <div style={{ padding: 20 }}>Loading and scraping URL...</div>}
        <Chat
          messages={(() => {
            // If in edit mode, replace the spun message with textarea
            if (editMode && spunMsg) {
              return currentSession.messages.map((m, i) =>
                i === (currentSession.messages.length - 1 - spunMsgIndex)
                  ? {
                      ...m,
                      content: (
                        <div style={{ position: 'relative' }}>
                          <textarea
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            style={{ width: '100%', minHeight: 120, fontSize: '1em', borderRadius: 8, padding: 12 }}
                          />
                          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                            <button
                              onClick={async () => {
                                setEditMode(false);
                                setEditValue('');
                                await handleEditWriter(editValue);
                              }}
                              disabled={editValue === spunMsg.content}
                              style={{
                                background: editValue !== spunMsg.content ? '#10a37f' : '#ccc',
                                color: '#fff', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '1em', cursor: editValue !== spunMsg.content ? 'pointer' : 'not-allowed',
                                opacity: editValue !== spunMsg.content ? 1 : 0.7
                              }}
                            >Save</button>
                            <button
                              onClick={handleCancelEdit}
                              style={{ background: '#eee', color: '#222', border: 'none', borderRadius: 6, padding: '8px 18px', fontSize: '1em', cursor: 'pointer' }}
                            >Cancel</button>
                          </div>
                        </div>
                      )
                    }
                  : m
              );
            }
            return currentSession.messages;
          })()}
          spunMsgIndex={spunMsgIndex}
          showEditButton={!editMode && !!spunMsg}
          onEditSpun={handleEditSpun}
          thumbAnim={thumbAnim}
          onThumbUp={async () => {
            setThumbAnim('up');
            setNotifications(n => [...n, 'Marked as helpful — the AI will learn from this!']);
            setNotification('Marked as helpful — the AI will learn from this!');
            setTimeout(() => setThumbAnim(null), 400);
            setTimeout(() => setNotification(null), 2000);
            setFeedbackSubmitted(true);
            await fetch('http://localhost:5050/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reward: 1 }),
            });
          }}
          onThumbDown={async () => {
            setThumbAnim('down');
            setNotifications(n => [...n, 'Marked as unhelpful — we’ll use this to improve.']);
            setNotification('Marked as unhelpful — we’ll use this to improve.');
            setTimeout(() => setThumbAnim(null), 400);
            setTimeout(() => setNotification(null), 2000);
            setFeedbackSubmitted(true);
            await fetch('http://localhost:5050/feedback', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reward: -1 }),
            });
          }}
          feedbackSubmitted={feedbackSubmitted}
        />
        {/* Chat input box below chat, above options */}
        <form className="chat-input-area" onSubmit={e => { e.preventDefault(); if (input.trim()) { handleSendMessage(input); setInput(''); } }} style={{ display: 'flex', alignItems: 'center', padding: 20, borderTop: '1px solid #eee', background: '#fafafa', position: 'sticky', bottom: 0, zIndex: 10 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Type your message..."
            style={{ flex: 1, padding: 12, border: '1px solid #ddd', borderRadius: 8, fontSize: '1em', marginRight: 12 }}
          />
          <button type="submit" style={{ background: '#10a37f', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: '1em', cursor: 'pointer' }}>Send</button>
        </form>
        {/* Show options after scraping (always show if scrapedContent and screenshotPath exist) */}
        {currentSession && currentSession.scrapedContent && currentSession.screenshotPath && (
          <div className="options-area">
            <button onClick={() => setShowScreenshotModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span role="img" aria-label="screenshot">🖼️</span> See Screenshot
            </button>
            <button onClick={handleShowScrapedData} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span role="img" aria-label="scraped-data">📄</span> See Scraped Data
            </button>
            {/* Version History button, only if there are saved versions */}
            {versionHistory.length > 1 && (
              <button onClick={() => setShowVersionHistoryModal(true)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span role="img" aria-label="history">🕑</span> Version History
              </button>
            )}
          </div>
        )}
        {/* Screenshot Modal without debug info */}
        {currentSession && currentSession.screenshotPath && showScreenshotModal && (() => {
          const imgPath = currentSession.screenshotPath.replace(/\\/g, '/').replace(/^[.\/]+/, '');
          return (
            <div style={{
              position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
              background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
            }}>
              <div style={{
                background: '#fff', padding: 20, borderRadius: 8, position: 'relative', maxWidth: '90vw', maxHeight: '90vh'
              }}>
                <button
                  onClick={() => setShowScreenshotModal(false)}
                  style={{
                    position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none',
                    fontSize: 24, cursor: 'pointer'
                  }}
                  aria-label="Close"
                >×</button>
                <img
                  src={`http://localhost:5000/${imgPath}`}
                  alt="Screenshot"
                  style={{ maxWidth: '80vw', maxHeight: '80vh', display: 'block', margin: '0 auto', border: '1px solid #ccc', borderRadius: 8 }}
                  onError={e => { e.target.style.display = 'none'; alert('Failed to load screenshot image! Check the path and backend.'); }}
                />
              </div>
            </div>
          );
        })()}
        {/* Scraped Data Modal */}
        {currentSession && currentSession.scrapedContent && showScrapedDataModal && (
          <div style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: '#fff', padding: 20, borderRadius: 8, position: 'relative', maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto'
            }}>
              <button
                onClick={handleCloseScrapedDataModal}
                style={{
                  position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none',
                  fontSize: 24, cursor: 'pointer'
                }}
                aria-label="Close"
              >×</button>
              <div style={{ whiteSpace: 'pre-wrap', maxWidth: '80vw', maxHeight: '80vh', overflow: 'auto' }}>
                {currentSession.scrapedContent}
              </div>
            </div>
          </div>
        )}
        {/* Version History Modal */}
        {showVersionHistoryModal && (
          <div style={{
            position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}>
            <div style={{
              background: '#fff', padding: 24, borderRadius: 10, minWidth: 400, maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto', position: 'relative'
            }}>
              <button
                onClick={() => setShowVersionHistoryModal(false)}
                style={{
                  position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none',
                  fontSize: 24, cursor: 'pointer'
                }}
                aria-label="Close"
              >×</button>
              <h3 style={{ marginTop: 0 }}>Version History</h3>
              <div>
                {versionHistory.slice().reverse().map((v, idx) => (
                  <div key={v.id} style={{
                    border: '1px solid #eee', borderRadius: 6, marginBottom: 10, padding: 12,
                    background: expandedVersion === v.id ? '#f7f7f7' : '#fafafa',
                    cursor: 'pointer',
                    boxShadow: expandedVersion === v.id ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'
                  }}
                  onClick={() => setExpandedVersion(expandedVersion === v.id ? null : v.id)}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span><b>v{versionHistory.length - idx}</b> by {v.editor} at {new Date(v.timestamp * 1000).toLocaleString()}</span>
                      <span>{expandedVersion === v.id ? '▲' : '▼'}</span>
                    </div>
                    {expandedVersion === v.id && (
                      <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', fontSize: '1em' }}>{v.content}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* Notification UI */}
        {notification && (
          <div className="feedback-notification" style={{ position: 'fixed', top: 24, right: 24, background: '#222', color: '#fff', padding: '16px 28px', borderRadius: 8, fontSize: '1.1em', zIndex: 9999, boxShadow: '0 2px 12px rgba(0,0,0,0.18)', transition: 'opacity 0.3s' }}>
            {notification}
          </div>
        )}
      </div>
      {shouldShowModal && (
        <UrlModal onSubmit={handleUrlSubmit} />
      )}
    </div>
  );
}

export default App;
