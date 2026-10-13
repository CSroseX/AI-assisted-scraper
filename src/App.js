import React from 'react';
import WatchesPage from './components/WatchesPage';
import './App.css';

function App() {
  return (
    <>
      <header className="app-nav">
        <span className="app-nav-title">Watchdog</span>
      </header>
      <WatchesPage />
    </>
  );
}

export default App;
