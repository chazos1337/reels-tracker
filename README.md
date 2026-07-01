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

## What's new (reliability update)

- **Pre-flight link validation** — links that aren't a specific post (a profile page, or a profile's "reels" tab with no post attached) used to just silently disappear from the counts, making a bad batch of submissions look like "nothing to fetch." Now they're listed by name up front, and you're offered a one-key option to mark them `BROKEN` in the sheet so they stop showing as missing.
- **Startup session check** — each account's cookies are validated against Instagram *before* the fetch queue is built, so an expired session is caught in one request instead of surfacing mid-run.
- **One-paste cookie setup** — paste the whole `cookie` request header once instead of copying `sessionid`, `csrftoken`, and `ds_user_id` into three separate prompts. See [Getting Instagram cookies](#getting-instagram-cookies).
- **Combined CSV support** — if your Google Sheets export already has `post_link` and `platform` alongside the `views_wN` columns, you can drop just that one file in `input/` instead of exporting submissions and Sheet1 separately.
- **Colorized console output** — green for successful fetches, yellow for deleted/paused/invalid, red for broken/errors, gray for cached/secondary info. Auto-disables when output isn't a real terminal (piped to a file, or `NO_COLOR` set).
- Fixed a bug where Instagram's `/reels/` (plural) URLs were silently rejected — only `/reel/` (singular) and `/p/` were recognized before.

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

1. Log into instagram.com in Chrome
2. Press `F12`, click the **Network** tab, then refresh the page (`F5`)
3. Click any request to `instagram.com` in the list, then click **Headers** on the right
4. Under **Request Headers**, find the row named `cookie`
5. Right-click it → **Copy value**
6. Paste it when the script asks for it

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
