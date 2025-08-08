# ai-assisted-scraper/backend/chroma_service/Dockerfile.rl
FROM python:3.10
WORKDIR /app

# Copy requirements file first (better caching)
COPY requirements.txt .

# Install dependencies
RUN pip install -r requirements.txt

COPY . .
RUN pip install flask flask_cors stable-baselines3 gym numpy
EXPOSE 5050
CMD ["python", "rl_backend.py"]