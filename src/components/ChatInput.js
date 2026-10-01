import React, { useState } from 'react';

function ChatInput({ onSend }) {
  const [input, setInput] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (input.trim()) {
      onSend(input);
      setInput('');
    }
  };

  return (
    <form
      className="chat-input-area"
      onSubmit={handleSubmit}
      style={{ display: 'flex', alignItems: 'center', padding: 20, borderTop: '1px solid #eee', background: '#fafafa', position: 'sticky', bottom: 0, zIndex: 10 }}
    >
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type your message..."
        style={{ flex: 1, padding: 12, border: '1px solid #ddd', borderRadius: 8, fontSize: '1em', marginRight: 12 }}
      />
      <button type="submit" style={{ background: '#10a37f', color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: '1em', cursor: 'pointer' }}>Send</button>
    </form>
  );
}

export default ChatInput;
