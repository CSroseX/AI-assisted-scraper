# AI-Assisted-scraper

Softnerve Assignment Round 1

## Project Overview
AI-Assisted-scraper is a multi-service application that leverages AI to scrape, process, and review web content. It features a React frontend, a Node.js/Express backend for scraping and AI integration, a FastAPI service for versioning with ChromaDB, and a Flask-based RL backend for reinforcement learning-based review.

## Capabilities
- Scrape web pages and extract main content and screenshots
- Rewrite and simplify content using Gemini AI
- Contextual chat and AI-powered review of rewritten content
- Version control for content using ChromaDB (FastAPI)
- Reinforcement learning-based review and feedback (Flask RL backend)

---

## Instructions to Run
This project requires **four terminals** to run all services simultaneously. Follow the steps below for each service.

### 1. Frontend (React)
```
cd ai-assisted-scraper
npm install
npm start
```
- Runs on [http://localhost:3000](http://localhost:3000)

### 2. Backend (Node.js/Express)
```
cd ai-assisted-scraper/backend
npm install
npm start
```
- Runs on [http://localhost:5000](http://localhost:5000) by default
- Requires a `.env` file with your Gemini API key:
  ```
  GEMINI_API_KEY=your_google_gemini_api_key
  ```

### 3. ChromaDB FastAPI Service (Python)
Install dependencies (requires Python 3.8+):
```
pip install fastapi uvicorn chromadb pydantic
```
Run the service:
```
cd ai-assisted-scraper/backend/chroma_service
uvicorn main:app --host 0.0.0.0 --port 8001
```
- Runs on [http://localhost:8001](http://localhost:8001)

### 4. RL Backend (Flask + Stable Baselines3)
Install dependencies:
```
pip install flask flask_cors stable-baselines3 gym numpy
```
Run the service:
```
cd ai-assisted-scraper/backend/chroma_service
python rl_backend.py
```
- Runs on [http://localhost:5050](http://localhost:5050)

---

## Notes
- Ensure all services are running for full functionality.
- Python dependencies for FastAPI and RL backend can be installed in the same environment.
- The backend requires a valid Gemini API key for AI features.
- ChromaDB will store versioned content in-memory by default.

---

For any issues, please check the respective service logs for errors.
