import React, { useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { normalizeAssistantMarkdown } from './utils/markdown';
import './Chat.css';

function Chat({ messages, spunIndex, showEditButton, onEditSpun }) {
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
            {/* Edit button for only the last spun content message */}
            {showEditButton && idx === spunIndex && (
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