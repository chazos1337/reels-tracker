# Duel Clipping — Instagram Reels View Tracker

Tracks Instagram reel view counts from a Google Sheets export and writes results back to a CSV you can re-import. Supports multiple Instagram accounts running in parallel for significantly faster scraping.

---

## What's new (multi-account update)

The original single-account version fetched one reel every 2–3 seconds. This version:

- **Multiple accounts in parallel** — add as many Instagram cookie accounts as you have. Each runs as its own independent worker, giving roughly N× speed with N accounts.
- **Faster per-request delay** — reduced from 2–3 s to 0.9–1.5 s with randomised jitter, which mimics human browsing patterns better than a fixed interval.
- **Auto-pause on any error** — if any worker hits a 4xx, 429, or rate-limit response it immediately puts the item back in the queue, backs off for 15 seconds, then retries. Other workers keep running unaffected.
- **Guided account setup on startup** — on first run (or when re-entering credentials) you're asked how many accounts you want to use, then prompted for each one's cookies in sequence. Accounts are saved to `cookies/` and reused on subsequent runs.
- **Expired session recovery** — if a session expires mid-run, that worker pauses and prompts for new cookies without stopping the other workers or losing progress.
- **Progress is never lost** — results are written to disk after every fetch via `cache.json` and `output/Sheet1_updated.csv`, so you can kill and resume at any point.

---

## Folder layout

```
reels-tracker/
├── tracker.js          ← main script
├── run.bat             ← double-click to run on Windows
├── cache.json          ← auto-generated, tracks fetched shortcodes
├── cookies/
│   ├── README.txt
│   ├── cookies_1.txt   ← one file per Instagram account
│   ├── cookies_2.txt
│   └── ...
├── input/
│   ├── duel-post-submission-history...csv
│   └── Sheet1...csv
└── output/
    └── Sheet1_updated.csv
```

---

## Setup

**Requirements:** [Node.js](https://nodejs.org) (v18+). No other dependencies.

1. Clone or download this repo
2. Export two CSVs from your Google Sheet into `input/`:
   - The submission history tab (contains `source_message_id`, `platform`, `post_link`)
   - The Sheet1 views tab (contains `views_w*` columns)
3. Run `run.bat` (Windows) or `node tracker.js`
4. On first run, enter how many accounts you want and paste the cookies for each

---

## Getting Instagram cookies

For each account:

1. Open Chrome and go to [instagram.com](https://www.instagram.com)
2. Log in to the account
3. Press `F12` → open the **Network** tab
4. Refresh the page, then click any request made to `instagram.com` in the list
5. In the panel that opens, find **Request Headers** and locate the line starting with `cookie:`
6. Copy everything after `cookie: ` — it'll be one long line with dozens of `key=value` pairs separated by semicolons
7. Paste that whole line when the script asks for it

You don't need to hunt down `sessionid`, `csrftoken`, and `ds_user_id` individually — the script pulls just those three out of whatever you paste and ignores the rest. If it can't find all three, it'll tell you which are missing and let you try again or enter them one at a time.

The tool also checks each saved session is still alive at startup, before building the fetch queue — so an expired cookie gets caught immediately instead of mid-run.

> Use dedicated throwaway accounts — not your personal Instagram.

Cookie files are saved in `cookies/cookies_1.txt`, `cookies_2.txt`, etc. On subsequent runs the script will ask if you want to reuse them or re-enter.

---

## Speed reference

| Accounts | Approx. time for 200 reels |
|----------|---------------------------|
| 1        | ~8 min                    |
| 3        | ~3 min                    |
| 5        | ~2 min                    |
| 10       | ~1 min                    |

Times assume 0.9–1.5 s per request per worker. Results vary based on Instagram's response times and rate limiting.

---

## Output

`output/Sheet1_updated.csv` — the Sheet1 CSV with a new `views_wN` column filled in. Import back to Google Sheets via **File → Import → Upload → Replace current sheet**.

---

## Cleaning up

To remove everything from this machine, delete the `reels-tracker/` folder. Nothing is installed globally.
