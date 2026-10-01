import pytest

import rl_backend


@pytest.fixture()
def client(monkeypatch):
    # Reset the module-level learner state so tests are independent.
    monkeypatch.setattr(rl_backend, "action_values", {0: 0.0, 1: 0.0})
    monkeypatch.setattr(rl_backend, "action_counts", {0: 0, 1: 0})
    monkeypatch.setattr(rl_backend, "review_store", {})
    monkeypatch.setattr(rl_backend, "last_review_id", None)
    monkeypatch.setattr(rl_backend, "epsilon", 0.0)  # deterministic: always exploit
    return rl_backend.app.test_client()


def review(client, text="One sentence. Another sentence here."):
    res = client.post("/review", json={"spunContent": text})
    assert res.status_code == 200, res.get_data(as_text=True)
    return res.get_json()


def test_review_requires_content(client):
    assert client.post("/review", json={}).status_code == 400
    assert client.post("/review", json={"spunContent": "   "}).status_code == 400
    assert client.post("/review", data="not json", content_type="text/plain").status_code == 400


def test_review_returns_text_action_and_id(client):
    data = review(client)
    assert data["review_id"] in rl_backend.review_store
    assert data["action"] in (0, 1)
    assert data["reviewed"].startswith(("Concise review", "Detailed review"))


def test_text_features_are_computed():
    features = rl_backend.build_text_features("The cat sat. The cat ran! Why?")
    assert features["sentence_count"] == 3
    assert features["word_count"] == 7
    assert "cat" not in features["keywords"]  # keywords need length > 3
    assert rl_backend.build_text_features("")["sentence_count"] == 1


def test_positive_feedback_makes_that_action_preferred(client):
    first = review(client)
    action = first["action"]
    res = client.post("/feedback", json={"reward": 1, "review_id": first["review_id"]})
    assert res.status_code == 200
    assert res.get_json()["policy"]["action_values"][str(action)] == 1.0
    # With epsilon 0 the rewarded arm is now always chosen.
    assert all(review(client)["action"] == action for _ in range(5))


def test_negative_feedback_steers_away_from_that_action(client):
    first = review(client)
    action = first["action"]
    client.post("/feedback", json={"reward": -1, "review_id": first["review_id"]})
    assert review(client)["action"] != action


def test_feedback_uses_incremental_mean(client):
    first = review(client)
    action = first["action"]
    for reward in (1, 0, 1):
        client.post("/feedback", json={"reward": reward, "review_id": first["review_id"]})
    assert rl_backend.action_values[action] == pytest.approx(2 / 3)
    assert rl_backend.action_counts[action] == 3


def test_feedback_defaults_to_the_last_review(client):
    review(client)
    assert client.post("/feedback", json={"reward": 1}).status_code == 200


def test_feedback_validation(client):
    assert client.post("/feedback", json={"reward": 1}).status_code == 400  # no review yet
    first = review(client)
    assert client.post("/feedback", json={"reward": "abc", "review_id": first["review_id"]}).status_code == 400
    assert client.post("/feedback", json={"reward": 1, "review_id": "unknown"}).status_code == 400


def test_health_reports_reviews_seen(client):
    review(client)
    res = client.get("/health")
    assert res.status_code == 200
    assert res.get_json() == {"status": "ok", "reviews_seen": 1}


def test_parse_allowed_origins_defaults_and_splits():
    assert rl_backend.parse_allowed_origins("") == ["http://localhost:3000"]
    assert rl_backend.parse_allowed_origins("https://a.com, https://b.com") == ["https://a.com", "https://b.com"]
