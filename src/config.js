export const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:5000';
export const RL_BASE = process.env.REACT_APP_RL_BASE || 'http://localhost:5050';

export const apiUrl = (path) => `${API_BASE}${path}`;
export const rlUrl = (path) => `${RL_BASE}${path}`;
