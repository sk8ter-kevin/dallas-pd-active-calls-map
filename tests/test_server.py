import unittest
from unittest.mock import AsyncMock, patch

import server


class ServerFetchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_calls = server.STATE.calls
        self.original_last_updated_at = server.STATE.last_updated_at
        self.original_last_error = server.STATE.last_error
        self.original_geocode_cache = server.STATE.geocode_cache
        self.original_geocode_attempts_since_refresh = server.STATE.geocode_attempts_since_refresh

    def tearDown(self):
        server.STATE.calls = self.original_calls
        server.STATE.last_updated_at = self.original_last_updated_at
        server.STATE.last_error = self.original_last_error
        server.STATE.geocode_cache = self.original_geocode_cache
        server.STATE.geocode_attempts_since_refresh = self.original_geocode_attempts_since_refresh

    async def test_do_single_fetch_keeps_existing_calls_when_fetch_fails(self):
        server.STATE.calls = [{"incidentNumber": "existing"}]
        server.STATE.last_updated_at = "2026-04-01T00:00:00Z"

        with patch("server.fetch_active_calls", AsyncMock(side_effect=RuntimeError("boom"))):
            with self.assertRaises(RuntimeError):
                await server.do_single_fetch(object())

        self.assertEqual(server.STATE.calls, [{"incidentNumber": "existing"}])
        self.assertEqual(server.STATE.last_updated_at, "2026-04-01T00:00:00Z")

    async def test_do_single_fetch_replaces_calls_after_successful_fetch(self):
        server.STATE.geocode_attempts_since_refresh = 3
        rows = [
            {
                "incident_number": "26-0000001",
                "division": "Central",
                "nature_of_call": "Test Call",
                "priority": "1",
                "date": "2026-04-01T00:00:00.000",
                "time": "12:00:00",
                "unit_number": "A100",
                "block": "100",
                "location": "Main St",
                "beat": "101",
                "reporting_area": "1000",
                "status": "At Scene",
            }
        ]

        with patch("server.fetch_active_calls", AsyncMock(return_value=rows)):
            await server.do_single_fetch(object())

        self.assertEqual(len(server.STATE.calls), 1)
        self.assertEqual(server.STATE.calls[0]["incidentNumber"], "26-0000001")
        self.assertIsNotNone(server.STATE.last_updated_at)
        self.assertIsNone(server.STATE.last_error)
        self.assertEqual(server.STATE.geocode_attempts_since_refresh, 0)


if __name__ == "__main__":
    unittest.main()
