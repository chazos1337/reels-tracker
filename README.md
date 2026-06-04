# Duel Clipping — Instagram View Tracker

Fetches view counts for Instagram reels and updates your Sheet1 tracking spreadsheet.

---

## Requirements

Install **Node.js** (free): https://nodejs.org — download the LTS version, run the installer, leave all defaults.

No other setup needed.

---

## How to export CSVs from Google Sheets

You need to do this before each weekly run.

1. Open the Google Sheet in your browser
2. Click the **duel-post-submission-history** tab at the bottom
3. Click **File → Download → Comma Separated Values (.csv)**
4. Repeat for the **Sheet1** tab
5. Move both downloaded `.csv` files into the **`input`** folder next to this program

---

## How to run

1. Drop your two CSVs into the `input/` folder
2. Double-click **`run.bat`**
3. Follow the prompts:
   - First run: paste your Instagram cookies (instructions shown on screen)
   - Choose which week to scan (or press Enter for all)
   - Choose which column to write views to (auto-suggested)
4. Watch it fetch — progress is saved live so if it crashes just re-run
5. When done, find **`output/Sheet1_updated.csv`**
6. Upload it back to Google Sheets: **File → Import → Upload → Replace current sheet**

---

## Cookie setup

Cookies are needed to access age-restricted Instagram content. Use a dedicated throwaway account.

1. Open Chrome → go to https://www.instagram.com → log in
2. Press **F12** → click **Application** tab → expand **Cookies** → click `https://www.instagram.com`
3. Copy the values for `sessionid`, `csrftoken`, `ds_user_id`
4. Paste when the program asks

Cookies are saved locally and reused until they expire (~2–4 weeks). The program will ask again automatically when they stop working.

---

## Output

`output/Sheet1_updated.csv` — your Sheet1 with a new `views_wXX` column added, filled with:

| Value | Meaning |
|-------|---------|
| `1234567` | View count fetched successfully |
| `DELETED` | Reel has been deleted or made private |
| `BROKEN` | Link couldn't be reached (timeout, error) |

---

## Folder structure

```
ig-tracker/
├── input/          ← drop your CSVs here
├── output/         ← updated Sheet1 appears here
├── run.bat         ← double-click to run
├── tracker.js      ← the program
├── cookies.txt     ← auto-created, stores your session
└── cache.json      ← auto-created, saves progress mid-run
```
