# Dallas PD Active Calls Map

A local web app that:

- pulls live active calls from Dallas Open Data
- geocodes call locations into latitude/longitude points
- plots mapped calls on an interactive map
- refreshes automatically on a timer

## Data Source

- Dallas Police Active Calls dataset:
  - https://www.dallasopendata.com/Public-Safety/Dallas-Police-Active-Calls/9fxf-t2tr/data_preview
  - API endpoint used by the app: `https://www.dallasopendata.com/resource/9fxf-t2tr.json`

## Requirements

- Python 3.10+

## Run

```bash
python3 server.py
```

Then open:

- http://localhost:3000

## Configuration

Environment variables you can set before starting:

- `PORT` (default `3000`)
- `HOST` (default `127.0.0.1`)
- `REFRESH_INTERVAL_MS` (default `120000`)
- `MAX_GEOCODES_PER_REFRESH` (default `8`)
- `GEOCODE_DELAY_MS` (default `1100`)
- `FAILED_RETRY_INTERVAL_MS` (default `21600000`)
- `DALLAS_CALLS_URL` (advanced override)
- `GEOCODER_USER_AGENT` (recommended to set with contact info)

## Notes

- The Dallas active calls dataset does not include direct lat/lon fields, so this app geocodes from block + location text.
- Calls that cannot be geocoded right away remain listed as "Unmapped."
- Geocode results are cached locally in `data/geocode-cache.json` (gitignored).
- Geocoding uses OpenStreetMap Nominatim.
