#!/usr/bin/env python3
"""Dallas PD active calls map server (FastAPI).

Serves static frontend files plus API endpoints:
- GET /api/calls
- GET /api/refresh
- GET /health
"""

import asyncio
import json
import os
import re
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

# --- Configuration ---
HOST = os.environ.get("HOST", "0.0.0.0")  # Bind to all interfaces by default for container friendliness
PORT = int(os.environ.get("PORT", "3000"))
REFRESH_INTERVAL_MS = int(os.environ.get("REFRESH_INTERVAL_MS", "120000"))
MAX_GEOCODES_PER_REFRESH = int(os.environ.get("MAX_GEOCODES_PER_REFRESH", "8"))
FAILED_RETRY_INTERVAL_MS = int(os.environ.get("FAILED_RETRY_INTERVAL_MS", str(6 * 60 * 60 * 1000)))
GEOCODE_DELAY_MS = int(os.environ.get("GEOCODE_DELAY_MS", "1100"))
DALLAS_CALLS_URL = os.environ.get(
    "DALLAS_CALLS_URL",
    "https://www.dallasopendata.com/resource/9fxf-t2tr.json?$limit=800&$order=time%20DESC",
)
GEOCODER_USER_AGENT = os.environ.get(
    "GEOCODER_USER_AGENT", "DallasPDActiveCalls/2.0 (contact: local-app)"
)

APP_ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = APP_ROOT / "public"
DATA_DIR = APP_ROOT / "data"
CACHE_FILE = DATA_DIR / "geocode-cache.json"

REFRESH_INTERVAL_SECONDS = REFRESH_INTERVAL_MS / 1000
GEOCODE_DELAY_SECONDS = GEOCODE_DELAY_MS / 1000
FAILED_RETRY_INTERVAL_SECONDS = FAILED_RETRY_INTERVAL_MS / 1000


# --- Data Structures & State ---

@dataclass
class AppState:
    calls: List[dict[str, Any]] = field(default_factory=list)
    geocode_cache: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_updated_at: Optional[str] = None
    last_error: Optional[str] = None
    geocode_attempts_this_run: int = 0
    refresh_in_flight: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

STATE = AppState()


# --- Utilities ---

def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_space(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def safe_float(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number == float("inf") or number == float("-inf"):
        return None
    if number != number:  # NaN check
        return None
    return number


def parse_iso(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        iso = value.replace("Z", "+00:00")
        return datetime.fromisoformat(iso).timestamp()
    except ValueError:
        return None


def get_cache_key(address: str) -> str:
    return normalize_space(address).lower()


def build_address(call: dict[str, Any]) -> Optional[str]:
    block = normalize_space(call.get("block"))
    location = normalize_space(call.get("location"))
    if not location:
        return None

    normalized_location = re.sub(r"\s*/\s*", " & ", location)
    if block:
        return f"{block} {normalized_location}, Dallas, TX"
    return f"{normalized_location}, Dallas, TX"


def read_geo_from_cache(address: Optional[str]) -> Optional[dict[str, Any]]:
    if not address:
        return None
    key = get_cache_key(address)
    cached = STATE.geocode_cache.get(key)
    if not cached:
        return None

    lat = safe_float(cached.get("lat"))
    lon = safe_float(cached.get("lon"))
    if lat is None or lon is None:
        return None
    return {"lat": lat, "lon": lon, "geocodeLabel": cached.get("label", "")}


def split_intersection(address: str) -> Optional[tuple[str, str]]:
    main_part = address.split(",")[0]
    if "&" not in main_part:
        return None
    pieces = [normalize_space(part) for part in main_part.split("&")]
    pieces = [part for part in pieces if part]
    if len(pieces) != 2:
        return None
    return pieces[0], pieces[1]


def build_geocode_queries(address: str) -> List[str]:
    queries: List[str] = [address]
    intersection = split_intersection(address)
    if intersection:
        first, second = intersection
        queries.append(f"{first} and {second}, Dallas, TX")
        queries.append(f"{first}, Dallas, TX")
        queries.append(f"{second}, Dallas, TX")
    
    deduped: List[str] = []
    for query in queries:
        if query not in deduped:
            deduped.append(query)
    return deduped


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


def persistence_sync():
    """Synchronous file write for simplicity, or could be async aiofiles."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        serialized = json.dumps(STATE.geocode_cache, indent=2)
        CACHE_FILE.write_text(serialized, encoding="utf-8")
    except Exception as e:
        print(f"Failed to persist cache: {e}")


def load_cache_sync():
    if not CACHE_FILE.exists():
        return
    try:
        raw = CACHE_FILE.read_text(encoding="utf-8")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            STATE.geocode_cache = parsed
            print(f"Loaded {len(STATE.geocode_cache)} geocoded locations.")
    except Exception as e:
        print(f"Unable to load geocode cache: {e}")


# --- Async Actions ---

async def fetch_active_calls(client: httpx.AsyncClient) -> List[dict[str, Any]]:
    try:
        resp = await client.get(
            DALLAS_CALLS_URL,
            headers={"Accept": "application/json", "User-Agent": GEOCODER_USER_AGENT},
            timeout=25.0
        )
        resp.raise_for_status()
        rows = resp.json()
        if not isinstance(rows, list):
            raise ValueError("Response is not a list")
        return rows
    except Exception as e:
        print(f"Fetch error: {e}")
        return []


async def nominatim_lookup(client: httpx.AsyncClient, query: str) -> Optional[dict[str, Any]]:
    params = {
        "format": "jsonv2",
        "limit": "1",
        "countrycodes": "us",
        "q": query,
    }
    url = "https://nominatim.openstreetmap.org/search"
    try:
        resp = await client.get(
            url,
            params=params,
            headers={
                "Accept": "application/json",
                "Accept-Language": "en-US",
                "User-Agent": GEOCODER_USER_AGENT
            },
            timeout=10.0
        )
        if resp.status_code != 200:
            return None
        rows = resp.json()
        if not isinstance(rows, list) or not rows:
            return None
        
        top = rows[0]
        lat = safe_float(top.get("lat"))
        lon = safe_float(top.get("lon"))
        if lat is None or lon is None:
            return None
            
        return {"lat": lat, "lon": lon, "label": str(top.get("display_name", ""))}
    except Exception:
        return None


async def geocode_address(client: httpx.AsyncClient, address: str) -> Optional[dict[str, Any]]:
    queries = build_geocode_queries(address)
    street_fallback_results: List[dict[str, Any]] = []

    for index, query in enumerate(queries):
        result = await nominatim_lookup(client, query)
        if result:
            if index <= 1:
                return result
            
            street_fallback_results.append(result)
            if len(street_fallback_results) == 2:
                return {
                    "lat": (street_fallback_results[0]["lat"] + street_fallback_results[1]["lat"]) / 2,
                    "lon": (street_fallback_results[0]["lon"] + street_fallback_results[1]["lon"]) / 2,
                    "label": "Approximate intersection midpoint (street fallback)",
                }
        
        # Polite delay between internal retries
        if index < len(queries) - 1:
            await asyncio.sleep(GEOCODE_DELAY_SECONDS)

    if len(street_fallback_results) == 1:
        return {
            "lat": street_fallback_results[0]["lat"],
            "lon": street_fallback_results[0]["lon"],
            "label": "Approximate location (single street fallback)",
        }
    return None


async def should_attempt_geocode(address: Optional[str]) -> bool:
    if not address:
        return False
    
    key = get_cache_key(address)
    cached = STATE.geocode_cache.get(key)
    
    # 1. New address -> Yes
    if not cached:
        return True
    
    # 2. Already has lat/lon -> No
    lat = safe_float(cached.get("lat"))
    lon = safe_float(cached.get("lon"))
    if lat is not None and lon is not None:
        return False

    # 3. Failed recently? -> No (Retry interval)
    last_attempt = parse_iso(cached.get("lastAttempt") or cached.get("updatedAt"))
    if last_attempt is None:
        return True
    
    return (time.time() - last_attempt) > FAILED_RETRY_INTERVAL_SECONDS


async def call_fetch_loop():
    """Fetches active calls from Dallas Open Data periodically."""
    async with httpx.AsyncClient() as client:
        while True:
            try:
                raw_calls = await fetch_active_calls(client)
                
                # Transform and update state
                next_state = [to_client_call(row) for row in raw_calls]
                
                async with STATE.lock:
                    STATE.calls = next_state
                    STATE.last_updated_at = utc_now_iso()
                    STATE.last_error = None
                
            except Exception as e:
                print(f"Data fetch loop error: {e}")
                async with STATE.lock:
                    STATE.last_error = str(e)
            
            await asyncio.sleep(REFRESH_INTERVAL_SECONDS)


async def geocode_worker_loop():
    """Continuously finds one unmapped address and geocodes it, obeying rate limits."""
    # We use a distinct client for geocoding to keep connections separate
    async with httpx.AsyncClient() as client:
        while True:
            target_address = None
            
            # 1. Find a candidate
            async with STATE.lock:
                # Prioritize calls that are currently active but have no coordinates
                for call in STATE.calls:
                    addr = call.get("address")
                    # We check the cache directly here to see if we should work on it
                    # (The 'call' object might be slightly stale if cache updated in bg, 
                    # but should_attempt_geocode checks the live cache)
                    if await should_attempt_geocode(addr):
                        target_address = addr
                        break
            
            # 2. Work on it
            if target_address:
                try:
                    result = await geocode_address(client, target_address)
                    
                    now = utc_now_iso()
                    entry = {
                        "lat": result["lat"] if result else None,
                        "lon": result["lon"] if result else None,
                        "label": result.get("label", "") if result else "",
                        "provider": "nominatim",
                        "lastAttempt": now,
                        "updatedAt": now,
                    }
                    
                    async with STATE.lock:
                        STATE.geocode_cache[get_cache_key(target_address)] = entry
                        STATE.geocode_attempts_this_run += 1 # Just a counter for stats
                    
                    persistence_sync()
                    
                    # Update the in-memory STATE.calls to reflect new coords immediately if present
                    # (Optional optimization: waiting for next fetch loop is also fine, 
                    # but immediate feedback is nicer)
                    async with STATE.lock:
                        for call in STATE.calls:
                            if get_cache_key(call.get("address") or "") == get_cache_key(target_address):
                                call.update(read_geo_from_cache(target_address) or {})

                except Exception as e:
                    print(f"Geocode worker error for {target_address}: {e}")
                
                # 3. Rate Limit Delay
                # Strict 1 second delay between requests to be safe
                await asyncio.sleep(1.1)
            else:
                # No work needed, sleep a bit longer
                await asyncio.sleep(2.0)


# --- FastAPI App ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    load_cache_sync()
    asyncio.create_task(call_fetch_loop())
    asyncio.create_task(geocode_worker_loop())
    yield
    # Shutdown
    persistence_sync()

app = FastAPI(title="Dallas PD Active Calls Map", lifespan=lifespan)

@app.get("/api/calls")
async def get_calls():
    async with STATE.lock:
        calls_copy = [dict(c) for c in STATE.calls]
        updated_at = STATE.last_updated_at
        error = STATE.last_error
        attempts = STATE.geocode_attempts_this_run
        
    mapped = [c for c in calls_copy if safe_float(c.get("lat")) is not None]
    
    return {
        "updatedAt": updated_at,
        "totalCalls": len(calls_copy),
        "mappedCalls": len(mapped),
        "unmappedCalls": len(calls_copy) - len(mapped),
        "geocodeAttemptsThisRun": attempts,
        "error": error,
        "calls": calls_copy
    }

@app.get("/api/refresh")
async def trigger_refresh():
    # Trigger background fetch immediately
    asyncio.create_task(call_fetch_loop())
    return {"status": "refresh_triggered"}

@app.get("/health")
async def health():
    return {"status": "ok", "uptime_check": True}

# Serve static files
app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="public")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, reload=True)
