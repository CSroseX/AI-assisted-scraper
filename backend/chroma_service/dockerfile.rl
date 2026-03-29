# ai-assisted-scraper/backend/chroma_service/Dockerfile.rl
FROM python:3.10
WORKDIR /app

# Copy service-specific requirements first (better caching)
COPY requirements-rl.txt .

# Install dependencies
RUN pip install -r requirements-rl.txt

COPY . .
EXPOSE 5050
CMD ["python", "rl_backend.py"]