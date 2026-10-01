import pytest
from fastapi.testclient import TestClient

import main


@pytest.fixture()
def client():
    # Start every test from an empty collection.
    main.client.delete_collection("chapter_versions")
    main.collection = main.client.get_or_create_collection("chapter_versions")
    return TestClient(main.app)


def add(client, content="hello", parent=None, editor="user"):
    body = {"content": content, "editor": editor}
    if parent is not None:
        body["parent_version"] = parent
    res = client.post("/version", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def test_add_version_returns_id_timestamp_and_editor(client):
    version = add(client, "first draft", editor="ai-writer")
    assert version["content"] == "first draft"
    assert version["editor"] == "ai-writer"
    assert version["parent_version"] == ""
    assert version["id"] and version["timestamp"] > 0


def test_get_version_round_trips(client):
    created = add(client, "round trip")
    res = client.get(f"/version/{created['id']}")
    assert res.status_code == 200
    assert res.json()["content"] == "round trip"


def test_get_missing_version_is_404(client):
    assert client.get("/version/does-not-exist").status_code == 404


def test_history_lists_versions_with_metadata(client):
    add(client, "one")
    add(client, "two")
    res = client.get("/version/history")
    assert res.status_code == 200
    data = res.json()
    assert sorted(data["documents"]) == ["one", "two"]
    assert len(data["ids"]) == len(data["metadatas"]) == 2


def test_history_limit_is_clamped_and_paginates(client):
    for i in range(3):
        add(client, f"v{i}")
    assert len(client.get("/version/history", params={"limit": 2}).json()["ids"]) == 2
    # Out-of-range values are clamped instead of erroring.
    assert client.get("/version/history", params={"limit": 0}).status_code == 200
    assert client.get("/version/history", params={"limit": 10_000, "offset": -5}).status_code == 200
    assert len(client.get("/version/history", params={"limit": 50, "offset": 2}).json()["ids"]) == 1


def test_restore_creates_a_new_version_pointing_at_the_original(client):
    original = add(client, "restore me")
    res = client.post(f"/version/restore/{original['id']}")
    assert res.status_code == 200
    restored = res.json()
    assert restored["id"] != original["id"]
    assert restored["content"] == "restore me"
    assert restored["parent_version"] == original["id"]
    assert len(client.get("/version/history").json()["ids"]) == 2


def test_restore_missing_version_is_404(client):
    assert client.post("/version/restore/nope").status_code == 404


def test_add_version_validates_payload(client):
    assert client.post("/version", json={}).status_code == 422


@pytest.mark.parametrize("headers", [{}, {"x-clear-token": "wrong"}, {"x-clear-token": ""}])
def test_clear_requires_the_token(client, headers):
    add(client, "keep me")
    assert client.post("/version/clear", headers=headers).status_code == 403
    assert len(client.get("/version/history").json()["ids"]) == 1


def test_clear_with_valid_token_empties_the_store(client):
    add(client, "gone soon")
    res = client.post("/version/clear", headers={"x-clear-token": "test-clear-token"})
    assert res.status_code == 200
    assert res.json() == {"status": "cleared"}
    assert client.get("/version/history").json()["ids"] == []


def test_clear_is_forbidden_when_no_token_is_configured(client, monkeypatch):
    monkeypatch.setenv("CLEAR_API_TOKEN", "")
    assert client.post("/version/clear", headers={"x-clear-token": ""}).status_code == 403
