"""SPEC §1, §4: auth, strict request bodies, one error envelope, self-description."""

from __future__ import annotations

from typing import Any, Callable

import pytest
from fastapi.testclient import TestClient

from inferno_service.config import Settings

VIDEO = "https://fake.test/video"
TOKEN = "s3cret-token"


# --- auth -------------------------------------------------------------------


@pytest.fixture
def secured(make_client: Callable[..., TestClient], settings: Settings) -> TestClient:
    return make_client(settings.replace(api_token=TOKEN))


def test_no_token_configured_means_no_token_required(client: TestClient) -> None:
    assert client.get("/health").status_code == 200
    assert client.get("/api/v1/downloads").status_code == 200


@pytest.mark.parametrize(
    "path", ["/health", "/api/v1/downloads", "/api/v1/info?url=https://fake.test/video"]
)
def test_a_missing_token_is_a_coded_401(secured: TestClient, path: str) -> None:
    response = secured.get(path)
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_a_wrong_token_is_rejected(secured: TestClient) -> None:
    assert secured.get("/health", headers={"X-API-Key": "wrong"}).status_code == 401
    assert secured.get("/health", params={"token": "wrong"}).status_code == 401


def test_the_header_form_is_accepted(secured: TestClient) -> None:
    assert secured.get("/health", headers={"X-API-Key": TOKEN}).status_code == 200


def test_the_query_form_is_accepted_on_rest_too(secured: TestClient) -> None:
    """SPEC §4: the query form exists for browser websockets, and is supported on
    REST for consistency."""
    assert secured.get("/health", params={"token": TOKEN}).status_code == 200


def test_websockets_need_the_query_token(secured: TestClient) -> None:
    with pytest.raises(Exception):
        with secured.websocket_connect("/ws/events") as socket:
            socket.receive_json()

    with secured.websocket_connect(f"/ws/events?token={TOKEN}") as socket:
        assert socket.receive_json()["type"] == "hello"


def test_a_token_protects_the_whole_flow(secured: TestClient) -> None:
    headers = {"X-API-Key": TOKEN}
    response = secured.post("/api/v1/downloads", json={"url": VIDEO}, headers=headers)
    assert response.status_code == 202
    job_id = response.json()["job_id"]
    assert secured.get(f"/api/v1/downloads/{job_id}").status_code == 401
    assert secured.get(f"/api/v1/downloads/{job_id}", headers=headers).status_code == 200


# --- strict requests --------------------------------------------------------


def test_unknown_fields_fail_loudly(client: TestClient) -> None:
    """SPEC §4: a typo in someone's integration should fail loudly at the
    boundary, not be silently ignored."""
    response = client.post("/api/v1/downloads", json={"url": VIDEO, "audio_only": True})
    assert response.status_code == 422
    body = response.json()["error"]
    assert body["code"] == "invalid_request"
    assert "audio_only" in body["message"]
    assert body["detail"]["errors"][0]["location"][-1] == "audio_only"


def test_a_typo_in_a_known_field_is_rejected(client: TestClient) -> None:
    response = client.post("/api/v1/downloads", json={"url": VIDEO, "qualtiy": "1080p"})
    assert response.status_code == 422
    assert "qualtiy" in response.json()["error"]["message"]


@pytest.mark.parametrize(
    "body",
    [
        {"url": VIDEO, "mode": "sound"},
        {"url": VIDEO, "quality": "1081p"},
        {"url": VIDEO, "audio_format": "wma"},
        {"url": VIDEO, "concurrent_fragments": 0},
        {"url": VIDEO, "concurrent_fragments": 99},
        {"url": VIDEO, "rate_limit": 0},
        {"url": VIDEO, "audio_quality": 1000},
        {"url": VIDEO, "subtitles": ["en; rm -rf"]},
        {"mode": "audio"},
    ],
)
def test_invalid_values_are_rejected_with_a_stable_code(
    client: TestClient, body: dict[str, Any]
) -> None:
    response = client.post("/api/v1/downloads", json=body)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_info_bodies_are_strict_too(client: TestClient) -> None:
    response = client.post("/api/v1/info", json={"url": VIDEO, "formats": True})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


# --- the error envelope -----------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("get", "/api/v1/downloads/nope", None),
        ("get", "/api/v1/info?url=rubbish", None),
        ("post", "/api/v1/downloads", {"url": "rubbish"}),
        ("post", "/api/v1/downloads", {"url": VIDEO, "nope": 1}),
        ("get", "/api/v1/downloads?status=bogus", None),
    ],
)
def test_every_failure_uses_the_one_envelope(
    client: TestClient, method: str, path: str, body: Any
) -> None:
    response = getattr(client, method)(path, **({"json": body} if body else {}))
    assert response.status_code >= 400
    payload = response.json()
    assert set(payload) == {"error"}
    assert set(payload["error"]) == {"code", "message", "detail"}
    assert isinstance(payload["error"]["code"], str)
    assert isinstance(payload["error"]["message"], str)
    assert isinstance(payload["error"]["detail"], dict)


# --- self-description -------------------------------------------------------


def test_openapi_is_served_and_describes_every_route(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    paths = set(schema["paths"])
    expected = {
        "/health",
        "/api/v1/info",
        "/api/v1/formats",
        "/api/v1/subtitles",
        "/api/v1/downloads",
        "/api/v1/downloads/{job_id}",
        "/api/v1/downloads/{job_id}/cancel",
        "/api/v1/downloads/{job_id}/files/{name}",
    }
    assert expected <= paths
    assert "get" in schema["paths"]["/api/v1/info"]
    assert "post" in schema["paths"]["/api/v1/info"]


def test_docs_are_served(client: TestClient) -> None:
    response = client.get("/docs")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_the_error_model_is_in_the_schema(client: TestClient) -> None:
    schema = client.get("/openapi.json").json()
    assert "ErrorResponse" in schema["components"]["schemas"]
    responses = schema["paths"]["/api/v1/downloads"]["post"]["responses"]
    assert "422" in responses


def test_the_bundled_web_client_is_served_as_an_ordinary_page(client: TestClient) -> None:
    response = client.get("/client")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_cors_is_permissive_by_default_for_local_tools(client: TestClient) -> None:
    response = client.get("/health", headers={"Origin": "http://localhost:1420"})
    assert response.headers["access-control-allow-origin"] == "*"


def test_cors_can_be_restricted(
    make_client: Callable[..., TestClient], settings: Settings
) -> None:
    restricted = make_client(settings.replace(cors_origins=("http://tauri.localhost",)))
    allowed = restricted.get("/health", headers={"Origin": "http://tauri.localhost"})
    assert allowed.headers["access-control-allow-origin"] == "http://tauri.localhost"
    denied = restricted.get("/health", headers={"Origin": "http://evil.test"})
    assert "access-control-allow-origin" not in denied.headers
