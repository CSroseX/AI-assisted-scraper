import React from 'react';
import Modal from './Modal';

function ScrapedDataModal({ content, onClose }) {
  return (
    <Modal onClose={onClose} label="Scraped data" panelStyle={{ overflow: 'auto' }}>
      <div style={{ whiteSpace: 'pre-wrap', maxWidth: '80vw', maxHeight: '80vh', overflow: 'auto' }}>
        {content}
      </div>
    </Modal>
  );
}

export default ScrapedDataModal;
