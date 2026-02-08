#!/usr/bin/env python3
"""Dallas PD active calls map server.

Serves static frontend files plus API endpoints:
- /api/calls
- /api/refresh
- /health
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3000"))
REFRESH_INTERVAL_MS = int(os.environ.get("REFRESH_INTERVAL_MS", "120000"))
MAX_GEOCODES_PER_REFRESH = int(os.environ.get("MAX_GEOCODES_PER_REFRESH", "8"))
FAILED_RETRY_INTERVAL_MS = int(
    os.environ.get("FAILED_RETRY_INTERVAL_MS", str(6 * 60 * 60 * 1000))
)
GEOCODE_DELAY_MS = int(os.environ.get("GEOCODE_DELAY_MS", "1100"))
DALLAS_CALLS_URL = os.environ.get(
    "DALLAS_CALLS_URL",
    "https://www.dallasopendata.com/resource/9fxf-t2tr.json?$limit=500&$order=time%20DESC",
)
GEOCODER_USER_AGENT = os.environ.get(
    "GEOCODER_USER_AGENT", "DallasPDActiveCalls/1.0 (contact: local-app)"
)

APP_ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = APP_ROOT / "public"
DATA_DIR = APP_ROOT / "data"
CACHE_FILE = DATA_DIR / "geocode-cache.json"

REFRESH_INTERVAL_SECONDS = REFRESH_INTERVAL_MS / 1000
GEOCODE_DELAY_SECONDS = GEOCODE_DELAY_MS / 1000
FAILED_RETRY_INTERVAL_SECONDS = FAILED_RETRY_INTERVAL_MS / 1000


@dataclass
class AppState:
    lock: threading.RLock = field(default_factory=threading.RLock)
    calls: list[dict[str, Any]] = field(default_factory=list)
    geocode_cache: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_updated_at: str | None = None
    last_error: str | None = None
    geocode_attempts_this_run: int = 0
    refresh_in_flight: bool = False


STATE = AppState()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None

    if number == float("inf") or number == float("-inf"):
        return None
    if number != number:
        return None
    return number


def parse_iso(value: str | None) -> float | None:
    if not value:
        return None
    try:
        iso = value.replace("Z", "+00:00")
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


def get_cache_key(address: str) -> str:
    return normalize_space(address).lower()


def build_address(call: dict[str, Any]) -> str | None:
    block = normalize_space(call.get("block"))
    location = normalize_space(call.get("location"))
    if not location:
        return None

    normalized_location = re.sub(r"\s*/\s*", " & ", location)
    if block:
        return f"{block} {normalized_location}, Dallas, TX"
    return f"{normalized_location}, Dallas, TX"


def read_geo_from_cache(address: str | None) -> dict[str, Any] | None:
    if not address:
        return None

    key = get_cache_key(address)
    with STATE.lock:
        cached = STATE.geocode_cache.get(key)

    if not cached:
        return None

    lat = safe_float(cached.get("lat"))
    lon = safe_float(cached.get("lon"))
    if lat is None or lon is None:
        return None

    return {"lat": lat, "lon": lon, "geocodeLabel": cached.get("label", "")}


def should_attempt_geocode(address: str | None) -> bool:
    if not address:
        return False

    key = get_cache_key(address)
    with STATE.lock:
        cached = STATE.geocode_cache.get(key)

    if not cached:
        return True

    lat = safe_float(cached.get("lat"))
    lon = safe_float(cached.get("lon"))
    if lat is not None and lon is not None:
        return False

    last_attempt = parse_iso(cached.get("lastAttempt") or cached.get("updatedAt"))
    if last_attempt is None:
        return True

    return (time.time() - last_attempt) > FAILED_RETRY_INTERVAL_SECONDS


def to_client_call(call: dict[str, Any]) -> dict[str, Any]:
    address = build_address(call)
    geo = read_geo_from_cache(address)
    return {
        "incidentNumber": normalize_space(call.get("incident_number")),
        "division": normalize_space(call.get("division")),
        "natureOfCall": normalize_space(call.get("nature_of_call")),
        "priority": normalize_space(call.get("priority")),
        "date": normalize_space(call.get("date")),
        "time": normalize_space(call.get("time")),
        "unitNumber": normalize_space(call.get("unit_number")),
        "block": normalize_space(call.get("block")),
        "location": normalize_space(call.get("location")),
        "beat": normalize_space(call.get("beat")),
        "reportingArea": normalize_space(call.get("reporting_area")),
        "status": normalize_space(call.get("status")),
        "address": address,
        "lat": geo["lat"] if geo else None,
        "lon": geo["lon"] if geo else None,
        "geocodeLabel": geo["geocodeLabel"] if geo else "",
    }


def update_call_coordinates_from_cache(calls: list[dict[str, Any]]) -> None:
    for call in calls:
        geo = read_geo_from_cache(call.get("address"))
        if not geo:
            continue
        call["lat"] = geo["lat"]
        call["lon"] = geo["lon"]
        call["geocodeLabel"] = geo["geocodeLabel"]


def load_geocode_cache() -> None:
    if not CACHE_FILE.exists():
        return

    try:
        raw = CACHE_FILE.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            with STATE.lock:
                STATE.geocode_cache = parsed
    except (OSError, json.JSONDecodeError) as error:
        print(f"Unable to load geocode cache: {error}")


def persist_geocode_cache() -> None:
    with STATE.lock:
        serialized = json.dumps(STATE.geocode_cache, indent=2)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(serialized, encoding="utf-8")


def write_geocode_result(address: str, result: dict[str, Any] | None) -> None:
    now = utc_now_iso()
    entry = {
        "lat": result["lat"] if result else None,
        "lon": result["lon"] if result else None,
        "label": result.get("label", "") if result else "",
        "provider": "nominatim",
        "lastAttempt": now,
        "updatedAt": now,
    }
    with STATE.lock:
        STATE.geocode_cache[get_cache_key(address)] = entry
    persist_geocode_cache()


def fetch_json(url: str, headers: dict[str, str] | None = None) -> Any:
    request = Request(url, headers=headers or {})
    try:
        with urlopen(request, timeout=25) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            payload = response.read().decode(charset, errors="replace")
    except HTTPError as error:
        raise RuntimeError(f"HTTP {error.code} for {url}") from error
    except URLError as error:
        raise RuntimeError(f"Network error for {url}: {error.reason}") from error

    try:
        return json.loads(payload)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Invalid JSON returned from {url}") from error


def fetch_active_calls() -> list[dict[str, Any]]:
    rows = fetch_json(
        DALLAS_CALLS_URL,
        headers={
            "Accept": "application/json",
            "User-Agent": GEOCODER_USER_AGENT,
        },
    )
    if not isinstance(rows, list):
        raise RuntimeError("Dallas active calls response is not an array.")
    return rows


def split_intersection(address: str) -> tuple[str, str] | None:
    main_part = address.split(",")[0]
    if "&" not in main_part:
        return None

    pieces = [normalize_space(part) for part in main_part.split("&")]
    pieces = [part for part in pieces if part]
    if len(pieces) != 2:
        return None

    return pieces[0], pieces[1]


def build_geocode_queries(address: str) -> list[str]:
    queries: list[str] = [address]
    intersection = split_intersection(address)
    if intersection:
        first, second = intersection
        queries.append(f"{first} and {second}, Dallas, TX")
        queries.append(f"{first}, Dallas, TX")
        queries.append(f"{second}, Dallas, TX")

    deduped: list[str] = []
    for query in queries:
        if query not in deduped:
            deduped.append(query)
    return deduped


def nominatim_lookup(query: str) -> dict[str, Any] | None:
    params = urlencode(
        {
            "format": "jsonv2",
            "limit": "1",
            "countrycodes": "us",
            "q": query,
        }
    )
    url = f"https://nominatim.openstreetmap.org/search?{params}"

    rows = fetch_json(
        url,
        headers={
            "Accept": "application/json",
            "Accept-Language": "en-US",
            "User-Agent": GEOCODER_USER_AGENT,
        },
    )

    if not isinstance(rows, list) or not rows:
        return None

    top = rows[0]
    lat = safe_float(top.get("lat"))
    lon = safe_float(top.get("lon"))
    if lat is None or lon is None:
        return None

    return {"lat": lat, "lon": lon, "label": str(top.get("display_name", ""))}


def geocode_address(address: str) -> dict[str, Any] | None:
    queries = build_geocode_queries(address)
    street_fallback_results: list[dict[str, Any]] = []

    for index, query in enumerate(queries):
        result = nominatim_lookup(query)
        if result:
            # First two queries are direct and intersection-aware attempts.
            if index <= 1:
                return result

            street_fallback_results.append(result)
            if len(street_fallback_results) == 2:
                return {
                    "lat": (street_fallback_results[0]["lat"] + street_fallback_results[1]["lat"])
                    / 2,
                    "lon": (street_fallback_results[0]["lon"] + street_fallback_results[1]["lon"])
                    / 2,
                    "label": "Approximate intersection midpoint (street fallback)",
                }

        if index < len(queries) - 1:
            time.sleep(GEOCODE_DELAY_SECONDS)

    if len(street_fallback_results) == 1:
        return {
            "lat": street_fallback_results[0]["lat"],
            "lon": street_fallback_results[0]["lon"],
            "label": "Approximate location (single street fallback)",
        }

    return None


def enrich_coordinates(calls: list[dict[str, Any]]) -> None:
    addresses = []
    seen = set()
    for call in calls:
        address = call.get("address")
        if not address or address in seen:
            continue
        seen.add(address)
        if should_attempt_geocode(address):
            addresses.append(address)

    attempts = 0
    for address in addresses:
        if attempts >= MAX_GEOCODES_PER_REFRESH:
            break

        try:
            result = geocode_address(address)
            write_geocode_result(address, result)
        except Exception as error:  # broad catch to keep refresh loop alive
            print(f'Geocode failed for "{address}": {error}')
            write_geocode_result(address, None)

        attempts += 1
        update_call_coordinates_from_cache(calls)
        time.sleep(GEOCODE_DELAY_SECONDS)

    with STATE.lock:
        STATE.geocode_attempts_this_run = attempts


def refresh_calls() -> None:
    with STATE.lock:
        if STATE.refresh_in_flight:
            return
        STATE.refresh_in_flight = True

    try:
        rows = fetch_active_calls()
        next_state = [to_client_call(row) for row in rows]

        with STATE.lock:
            STATE.calls = next_state
            STATE.last_updated_at = utc_now_iso()
            STATE.last_error = None
            STATE.geocode_attempts_this_run = 0

        enrich_coordinates(next_state)

        with STATE.lock:
            STATE.calls = next_state
    except Exception as error:  # broad catch to keep server healthy
        print(f"Refresh failed: {error}")
        with STATE.lock:
            STATE.last_error = str(error)
    finally:
        with STATE.lock:
            STATE.refresh_in_flight = False


def start_refresh_loop() -> None:
    def worker() -> None:
        while True:
            refresh_calls()
            time.sleep(REFRESH_INTERVAL_SECONDS)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()


def build_api_payload() -> dict[str, Any]:
    with STATE.lock:
        calls_copy = [dict(call) for call in STATE.calls]
        updated_at = STATE.last_updated_at
        error = STATE.last_error
        attempts = STATE.geocode_attempts_this_run

    mapped = [
        call
        for call in calls_copy
        if safe_float(call.get("lat")) is not None and safe_float(call.get("lon")) is not None
    ]

    return {
        "updatedAt": updated_at,
        "totalCalls": len(calls_copy),
        "mappedCalls": len(mapped),
        "unmappedCalls": len(calls_copy) - len(mapped),
        "geocodeAttemptsThisRun": attempts,
        "error": error,
        "calls": calls_copy,
    }


class DallasHandler(BaseHTTPRequestHandler):
    server_version = "DallasPDActiveCalls/1.0"

    def do_GET(self) -> None:  # noqa: N802 (required by BaseHTTPRequestHandler)
        parsed = urlparse(self.path)
        pathname = parsed.path

        if pathname == "/api/calls":
            self._send_json(HTTPStatus.OK, build_api_payload())
            return

        if pathname == "/api/refresh":
            threading.Thread(target=refresh_calls, daemon=True).start()
            self._send_json(HTTPStatus.ACCEPTED, {"ok": True})
            return

        if pathname == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return

        self._serve_static(pathname)

    def do_POST(self) -> None:  # noqa: N802
        self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Method not allowed"})

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        print(f"{self.client_address[0]} - {format % args}")

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, pathname: str) -> None:
        relative = "index.html" if pathname == "/" else pathname.lstrip("/\\")
        target = (PUBLIC_DIR / relative).resolve()

        if not str(target).startswith(str(PUBLIC_DIR.resolve())):
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "Forbidden"})
            return

        if not target.exists() or not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND.value, "Not found")
            return

        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        charset_types = {"application/javascript", "application/json", "image/svg+xml"}
        if content_type.startswith("text/") or content_type in charset_types:
            header_content_type = f"{content_type}; charset=utf-8"
        else:
            header_content_type = content_type
        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR.value, "Unable to read file")
            return

        self.send_response(HTTPStatus.OK.value)
        self.send_header("Content-Type", header_content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    load_geocode_cache()
    refresh_calls()
    start_refresh_loop()

    server = ThreadingHTTPServer((HOST, PORT), DallasHandler)
    print(f"Dallas PD Active Calls map running at http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
