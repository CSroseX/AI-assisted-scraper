import React from 'react';
import NotificationBell from './NotificationBell';

function AppHeader({ onNewChat, notifications }) {
  return (
    <div className="chat-header">
      <button onClick={onNewChat}>+ New Chat</button>
      <h1>AI Assisted scraper</h1>
      <NotificationBell notifications={notifications} />
    </div>
  );
}

export default AppHeader;
