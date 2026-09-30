import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeAssistantMarkdown } from './utils/markdown';
import { findLastIndexByType } from './utils/messages';
import './Chat.css';

function Chat({ messages, showEditButton, onEditSpun, thumbAnim, onThumbUp, onThumbDown, feedbackSubmitted }) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const lastSpunContentIdx = findLastIndexByType(messages, 'spunContent');
  return (
    <div className="chat-container">
      <div className="messages">
        {messages.map((msg, idx) => (
          <div key={idx} className={`message ${msg.role}`}> 
            {typeof msg.content === 'string' && msg.role === 'assistant' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {normalizeAssistantMarkdown(msg.content)}
              </ReactMarkdown>
            ) : (
              <span>{msg.content}</span>
            )}
            {/* Edit and thumbs for only the last spun content message */}
            {showEditButton && idx === lastSpunContentIdx && (
              <div style={{ position: 'relative', width: '100%', height: 0, display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <button
                  onClick={onEditSpun}
                  style={{
                    background: '#10a37f',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '50%',
                    width: 40,
                    height: 40,
                    fontSize: 20,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    zIndex: 10
                  }}
                  title="Edit spun content"
                >✏️</button>
                {/* Thumbs up/down beside edit */}
                <button
                  className={thumbAnim === 'up' ? 'thumb-anim' : ''}
                  onClick={onThumbUp}
                  style={{ background: '#10a37f', color: '#fff', border: 'none', borderRadius: '50%', width: 36, height: 36, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.2s' }}
                  disabled={feedbackSubmitted}
                  title="Thumbs Up"
                >👍</button>
                <button
                  className={thumbAnim === 'down' ? 'thumb-anim' : ''}
                  onClick={onThumbDown}
                  style={{ background: '#ff5c5c', color: '#fff', border: 'none', borderRadius: '50%', width: 36, height: 36, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'transform 0.2s' }}
                  disabled={feedbackSubmitted}
                  title="Thumbs Down"
                >👎</button>
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}

export default Chat; 