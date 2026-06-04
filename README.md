# IG Reels View Tracker

Weekly view count tracker for Instagram Reels. Handles age-restricted content via authenticated session cookies.

## Requirements

- [Node.js](https://nodejs.org) (v18 or newer) — no other installs needed

## Setup

1. Edit **`reels.csv`** — add your reel URLs (and optionally a `username` column)
2. Double-click **`run.bat`**
3. On first run, paste your Instagram cookies when prompted

## reels.csv format

```
url,username
https://www.instagram.com/reel/ABC123/,johndoe
https://www.instagram.com/reel/DEF456/,janedoe
```

- `url` — required. Full IG reel URL (tracking params are stripped automatically)
- `username` — optional. Groups results by submitter in the report

## Getting cookies

1. Open [instagram.com](https://instagram.com) in Chrome, log in with your tracker account
2. Press F12 → Application → Cookies → `https://www.instagram.com`
3. Copy the values for `sessionid`, `csrftoken`, `ds_user_id`
4. Paste them when the script asks (or edit `cookies.txt` directly)

## Output

Reports are saved to `reports/report_YYYY-MM-DD.csv` with columns:

| Column | Description |
|--------|-------------|
| username | Submitter (from input CSV) |
| url | Reel URL |
| shortcode | IG shortcode |
| views | Views this run |
| prev_views | Views last run |
| delta | Change (+/-) |
| delta_pct | % change |
| error | Any fetch error |

## How it works

- **Cache:** All runs are stored in `cache.db`. If the script dies mid-run, just re-run it — already-fetched reels are skipped.
- **Cookie expiry:** If IG returns auth errors mid-run, the script pauses and asks for new cookies, then continues.
- **Delta:** Each report compares against the previous run automatically.
