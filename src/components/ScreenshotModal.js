import React from 'react';
import Modal from './Modal';
import { apiUrl } from '../config';
import { reportError } from '../utils/errors';
import { normalizeScreenshotPath } from '../utils/messages';

function ScreenshotModal({ screenshotPath, onClose }) {
  return (
    <Modal onClose={onClose} label="Screenshot">
      <img
        src={apiUrl(`/${normalizeScreenshotPath(screenshotPath)}`)}
        alt="Screenshot"
        style={{ maxWidth: '80vw', maxHeight: '80vh', display: 'block', margin: '0 auto', border: '1px solid #ccc', borderRadius: 8 }}
        onError={(e) => {
          e.target.style.display = 'none';
          reportError(new Error('Failed to load screenshot image! Check the path and backend.'));
        }}
      />
    </Modal>
  );
}

export default ScreenshotModal;
