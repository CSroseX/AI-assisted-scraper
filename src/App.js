import React, { useState } from 'react';
import Sidebar from './Sidebar';
import Chat from './Chat';
import UrlModal from './UrlModal';
import AppHeader from './components/AppHeader';
import ChatInput from './components/ChatInput';
import OptionsBar from './components/OptionsBar';
import ScrapedDataModal from './components/ScrapedDataModal';
import ScreenshotModal from './components/ScreenshotModal';
import SpunEditor from './components/SpunEditor';
import Toast from './components/Toast';
import { useNotifications } from './hooks/useNotifications';
import { useScrapeWorkflow } from './hooks/useScrapeWorkflow';
import { useSessions } from './hooks/useSessions';
import { useSpunEditor } from './hooks/useSpunEditor';
import { findLastIndexByType } from './utils/messages';
import './App.css';

function App() {
  const { sessions, currentSession, currentSessionId, selectSession, updateSession, addSession, deleteSession } = useSessions();
  const { notifications, toast, notify } = useNotifications();
  const workflow = useScrapeWorkflow({
    currentSession,
    currentSessionId,
    updateSession,
    notify
  });

  const [modal, setModal] = useState(null); // 'screenshot' | 'scrapedData' | null

  const messages = currentSession?.messages || [];
  const spunIndex = findLastIndexByType(messages, 'spunContent');
  const spunMsg = spunIndex === -1 ? null : messages[spunIndex];
  const editor = useSpunEditor(spunMsg);

  // The URL modal is shown whenever the active chat is still waiting for a URL.
  const awaitingUrl = !!currentSession?.awaitingUrl;

  const chatMessages = editor.editing && spunMsg
    ? messages.map((m, i) => (i !== spunIndex ? m : {
        ...m,
        content: (
          <SpunEditor
            value={editor.value}
            original={spunMsg.content}
            onChange={editor.setValue}
            onSave={async () => {
              const edited = editor.value;
              editor.stop();
              await workflow.editWriter(edited);
            }}
            onCancel={editor.stop}
          />
        )
      }))
    : messages;

  const hasScrape = !!(currentSession?.scrapedContent && currentSession?.screenshotPath);

  return (
    <div className="app-layout">
      <Sidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={selectSession}
        onDeleteSession={deleteSession}
      />
      <div className="main-area" style={{ filter: awaitingUrl ? 'blur(2px)' : 'none', pointerEvents: awaitingUrl ? 'none' : 'auto' }}>
        <AppHeader onNewChat={addSession} notifications={notifications} />
        {workflow.loading && <div style={{ padding: 20 }}>Loading and scraping URL...</div>}
        <Chat
          messages={chatMessages}
          spunIndex={spunIndex}
          showEditButton={!editor.editing && !!spunMsg}
          onEditSpun={editor.start}
        />
        <ChatInput onSend={workflow.sendMessage} />
        {hasScrape && (
          <OptionsBar
            onShowScreenshot={() => setModal('screenshot')}
            onShowScrapedData={() => setModal('scrapedData')}
          />
        )}
        {modal === 'screenshot' && currentSession?.screenshotPath && (
          <ScreenshotModal screenshotPath={currentSession.screenshotPath} onClose={() => setModal(null)} />
        )}
        {modal === 'scrapedData' && currentSession?.scrapedContent && (
          <ScrapedDataModal content={currentSession.scrapedContent} onClose={() => setModal(null)} />
        )}
        <Toast message={toast} />
      </div>
      {awaitingUrl && <UrlModal onSubmit={workflow.submitUrl} />}
    </div>
  );
}

export default App;
