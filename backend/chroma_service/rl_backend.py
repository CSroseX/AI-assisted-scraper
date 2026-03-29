import random
import uuid
from collections import Counter

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)


def parse_allowed_origins(raw: str) -> list[str]:
    values = [v.strip() for v in str(raw or "").split(",") if v.strip()]
    return values if values else ["http://localhost:3000"]


allowed_origins = parse_allowed_origins(__import__("os").getenv("CORS_ALLOWED_ORIGINS", ""))
CORS(app, resources={r"/*": {"origins": allowed_origins}})

# Lightweight online preference learner:
# action 0 -> concise review style
# action 1 -> detailed review style
action_values = {0: 0.0, 1: 0.0}
action_counts = {0: 0, 1: 0}
epsilon = 0.2

# Maps review_id -> action metadata so /feedback can update the correct arm.
review_store = {}
last_review_id = None


def tokenize(text):
    return [t.strip(".,!?;:\"'()[]{}") for t in text.split() if t.strip()]


def build_text_features(content):
    tokens = tokenize(content.lower())
    wc = len(tokens)
    sentence_count = max(1, content.count(".") + content.count("!") + content.count("?"))
    avg_sentence_len = wc / sentence_count
    common = Counter(tokens).most_common(5)
    keywords = [w for w, _ in common if len(w) > 3]
    return {
        "word_count": wc,
        "sentence_count": sentence_count,
        "avg_sentence_len": round(avg_sentence_len, 1),
        "keywords": keywords
    }


def choose_action():
    if random.random() < epsilon:
        return random.choice([0, 1])
    return 0 if action_values[0] >= action_values[1] else 1


def render_review(content, features, action):
    if action == 0:
        return (
            "Concise review:\n"
            f"- Length: {features['word_count']} words across {features['sentence_count']} sentences.\n"
            f"- Readability: average sentence length is {features['avg_sentence_len']} words.\n"
            "- Improvement: tighten repetitive phrasing and keep one idea per sentence for clarity."
        )

    keyword_text = ", ".join(features["keywords"]) if features["keywords"] else "(no dominant keywords)"
    return (
        "Detailed review:\n"
        f"1. Structure: The text has {features['sentence_count']} sentences and {features['word_count']} words. "
        "Consider clearer paragraph boundaries for better flow.\n"
        f"2. Clarity: Average sentence length is {features['avg_sentence_len']} words; split long sentences where possible.\n"
        f"3. Focus: Dominant terms are {keyword_text}. Remove redundancy around repeated terms.\n"
        "4. Revision tip: Start each paragraph with a topic sentence, then support it with one concrete detail."
    )

@app.route('/review', methods=['POST'])
def review():
    global last_review_id
    data = request.get_json(silent=True) or {}
    content = str(data.get('spunContent', '')).strip()
    if not content:
        return jsonify({'error': 'spunContent is required'}), 400

    action = choose_action()
    features = build_text_features(content)
    review_text = render_review(content, features, action)

    review_id = str(uuid.uuid4())
    review_store[review_id] = {
        'action': action,
        'content_chars': len(content)
    }
    last_review_id = review_id

    return jsonify({
        'reviewed': review_text,
        'action': action,
        'review_id': review_id,
        'policy': {
            'epsilon': epsilon,
            'action_values': action_values,
            'action_counts': action_counts
        }
    })

@app.route('/feedback', methods=['POST'])
def feedback():
    data = request.get_json(silent=True) or {}

    try:
        reward = float(data.get('reward', 0))
    except (TypeError, ValueError):
        return jsonify({'error': 'reward must be a number'}), 400

    review_id = data.get('review_id') or last_review_id
    if not review_id or review_id not in review_store:
        return jsonify({'error': 'No valid review_id to apply feedback'}), 400

    action = review_store[review_id]['action']
    action_counts[action] += 1

    # Incremental mean update for selected action.
    n = action_counts[action]
    action_values[action] = action_values[action] + (reward - action_values[action]) / n

    return jsonify({
        'status': 'feedback received',
        'reward': reward,
        'review_id': review_id,
        'action': action,
        'policy': {
            'action_values': action_values,
            'action_counts': action_counts
        }
    })


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'reviews_seen': len(review_store)})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050) 