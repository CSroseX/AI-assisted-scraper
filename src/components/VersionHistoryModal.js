import React, { useState } from 'react';
import Modal from './Modal';

function VersionHistoryModal({ versions, onClose }) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <Modal
      onClose={onClose}
      label="Version history"
      panelStyle={{ padding: 24, borderRadius: 10, minWidth: 400, maxHeight: '80vh', overflowY: 'auto' }}
    >
      <h3 style={{ marginTop: 0 }}>Version History</h3>
      <div>
        {versions.slice().reverse().map((v, idx) => {
          const expanded = expandedId === v.id;
          return (
            <div
              key={v.id}
              style={{
                border: '1px solid #eee', borderRadius: 6, marginBottom: 10, padding: 12,
                background: expanded ? '#f7f7f7' : '#fafafa',
                cursor: 'pointer',
                boxShadow: expanded ? '0 2px 8px rgba(0,0,0,0.08)' : 'none'
              }}
              onClick={() => setExpandedId(expanded ? null : v.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span><b>v{versions.length - idx}</b> by {v.editor} at {new Date(v.timestamp * 1000).toLocaleString()}</span>
                <span>{expanded ? '▲' : '▼'}</span>
              </div>
              {expanded && (
                <div style={{ marginTop: 10, whiteSpace: 'pre-wrap', fontSize: '1em' }}>{v.content}</div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export default VersionHistoryModal;
