'use strict';

/**
 * Duel Clipping — Instagram View Tracker
 *
 * Reads two CSVs from input/:
 *   - Submission history (duel-post-submission-history...)
 *   - View sheet (Sheet1...)
 *
 * Filters Instagram posts for a chosen week, finds ones missing
 * views in the target column, fetches from IG, updates Sheet1.
 *
 * Output → output/Sheet1_updated.csv
 */

const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ── paths ─────────────────────────────────────────────────────────────────────
const DIR          = __dirname;
const INPUT_DIR    = path.join(DIR, 'input');
const OUTPUT_DIR   = path.join(DIR, 'output');
const COOKIES_FILE = path.join(DIR, 'cookies.txt');
const CACHE_FILE   = path.join(DIR, 'cache.json');

// ── CSV ───────────────────────────────────────────────────────────────────────
function splitLine(line) {
  const out = []; let cur = '', q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  let lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  // Strip Google Sheets export prefix row ("Untitled spreadsheet - ...")
  if (lines[0].match(/^"?[^,]+ - [^,]+"?,*$/i) && !lines[0].toLowerCase().includes('source_message_id') && !lines[0].toLowerCase().includes('views_')) {
    lines = lines.slice(1);
  }
  const headers = splitLine(lines[0]).map(h => h.trim());
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = splitLine(l);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] ?? '').trim());
    return obj;
  });
  return { headers, rows };
}

function serializeCSV(headers, rows) {
  const esc = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(','));
  return lines.join('\n');
}

// ── cache (simple JSON — no native sqlite needed) ─────────────────────────────
let cache = {};
function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    try {
      cache = JSON.parse(raw);
      console.log(`  ✓ Cache loaded: ${Object.keys(cache).length} entries`);
    } catch (e) {
      console.error(`\n  ✗ cache.json is corrupted and could not be parsed: ${e.message}`);
      console.error('  Refusing to continue — fix or delete cache.json first.\n');
      process.exit(1);
    }
  }
}
function saveCache() { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); }
function cacheKey(runLabel, shortcode) { return `${runLabel}::${shortcode}`; }

// ── cookies ───────────────────────────────────────────────────────────────────
let cookies = {};

function loadCookies() {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  cookies = {};
  for (const line of fs.readFileSync(COOKIES_FILE, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) cookies[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return !!(cookies.sessionid && cookies.csrftoken && cookies.ds_user_id);
}

function saveCookies() {
  fs.writeFileSync(COOKIES_FILE, Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('\n'));
}

function cookieStr() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── terminal helpers ──────────────────────────────────────────────────────────
const W = 64;
const hr   = (c = '─') => c.repeat(W);
const bold = s => s; // plain terminal, no ANSI needed

function header(sub) {
  console.clear();
  console.log(hr('━'));
  console.log('  Duel Clipping — Instagram View Tracker');
  console.log(hr('━'));
  if (sub) { console.log(''); console.log(`  ${sub}`); console.log(hr()); }
  console.log('');
}

function ask(q, def) {
  const hint = def !== undefined ? ` [${def}]` : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  ${q}${hint}: `, ans => {
      rl.close();
      const trimmed = ans.trim();
      resolve(trimmed === '' && def !== undefined ? def : trimmed);
    });
  });
}

function choose(q, options) {
  return new Promise(async resolve => {
    while (true) {
      const ans = await ask(q);
      const match = options.find(o => o.key.toLowerCase() === ans.toLowerCase());
      if (match) return resolve(match.key);
      console.log('  Invalid choice, try again.\n');
    }
  });
}

async function pause(msg = 'Press Enter to continue...') { await ask(msg); }

// ── IG API ────────────────────────────────────────────────────────────────────
function stripShortcode(url) {
  const m = (url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:reel|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function shortcodeToId(sc) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(0);
  for (const c of sc) n = n * BigInt(64) + BigInt(alpha.indexOf(c));
  return n.toString();
}

function fetchViews(shortcode) {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'i.instagram.com',
      path: `/api/v1/media/${shortcodeToId(shortcode)}/info/`,
      method: 'GET',
      headers: {
        'User-Agent' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'X-CSRFToken': cookies.csrftoken,
        'Referer'    : 'https://www.instagram.com/',
        'X-IG-App-ID': '936619743392459',
        'Cookie'     : cookieStr(),
      },
    }, res => {
      if (res.statusCode === 302) {
        res.resume();
        resolve({ views: null, authFail: true, redirect: true, error: '302 redirect (session expired)' });
        return;
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data?.items?.[0]) {
            const item = data.items[0];
            resolve({ views: item.play_count ?? item.view_count ?? 0, authFail: false, error: null });
          } else {
            const authMsg  = /login_required|checkpoint_required|not_authorized/i.test(data?.message || '');
            const authFail = res.statusCode === 401 || res.statusCode === 403 || authMsg;
            const gone     = /not_found|media_not_found|deleted/i.test(data?.message || '');
            resolve({ views: null, authFail, gone, error: data?.message || `HTTP ${res.statusCode}` });
          }
        } catch {
          resolve({ views: null, authFail: false, error: 'parse error' });
        }
      });
    });
    req.on('error', e => resolve({ views: null, authFail: false, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ views: null, authFail: false, error: 'timeout' }); });
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── file detection ────────────────────────────────────────────────────────────
function sniffHeader(text) {
  // Returns the actual header line, skipping any Google Sheets prefix row
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  for (const line of lines) {
    const lower = line.toLowerCase();
    // A real header has multiple comma-separated identifiable words, no spaces-only tokens
    if (lower.includes('source_message_id') || lower.includes('submission_id') ||
        lower.includes('views_') || lower.includes('post_link') || lower.includes('platform')) {
      return lower;
    }
  }
  return lines[0] ? lines[0].toLowerCase() : '';
}

function detectInputFiles() {
  if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR);
  const csvs = fs.readdirSync(INPUT_DIR).filter(f => f.toLowerCase().endsWith('.csv'));

  let submissions = null, sheet1 = null;

  for (const f of csvs) {
    const text = fs.readFileSync(path.join(INPUT_DIR, f), 'utf8');
    const header = sniffHeader(text);
    // Sheet1 check first — it also has source_message_id but uniquely has views_ columns
    if (header.includes('views_')) {
      sheet1 = f;
    } else if (header.includes('source_message_id') && header.includes('submission_id')) {
      submissions = f;
    }
  }

  return { submissions, sheet1, all: csvs };
}

// ── week utils ────────────────────────────────────────────────────────────────
function availableWeeks(rows, colWeek) {
  const set = new Set(rows.map(r => r[colWeek]).filter(Boolean));
  return [...set].sort();
}

function detectNextViewsColumn(headers) {
  const viewCols = headers.filter(h => /^views_w?\d+$/i.test(h));
  if (!viewCols.length) return { col: 'views_w1', num: 1 };
  const nums = viewCols.map(h => parseInt(h.replace(/[^0-9]/g, ''))).filter(n => !isNaN(n));
  const max  = Math.max(...nums);
  return { col: `views_w${max + 1}`, num: max + 1, prev: `views_w${max}` };
}

// ── cookie setup screen ───────────────────────────────────────────────────────
async function cookieSetup(reason = '') {
  header('Cookie Setup');

  if (reason) { console.log(`  ⚠  ${reason}\n`); }

  console.log('  Instagram blocks unauthenticated access to age-restricted content.');
  console.log('  You need to provide session cookies from a logged-in Instagram account.\n');
  console.log('  HOW TO GET YOUR COOKIES:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  1. Open Chrome and go to https://www.instagram.com');
  console.log('  2. Log in to your Instagram account (use a dedicated throwaway)');
  console.log('  3. Press F12 to open DevTools');
  console.log('  4. Click the "Application" tab at the top');
  console.log('  5. In the left panel, expand "Cookies" → click "https://www.instagram.com"');
  console.log('  6. Find and copy the values for these three cookies:');
  console.log('       sessionid    (long string with %3A in it)');
  console.log('       csrftoken    (shorter string with dashes)');
  console.log('       ds_user_id   (your numeric user ID)');
  console.log('  ─────────────────────────────────────────────────────────────\n');

  cookies.sessionid  = await ask('Paste sessionid');
  cookies.csrftoken  = await ask('Paste csrftoken');
  cookies.ds_user_id = await ask('Paste ds_user_id');
  saveCookies();
  console.log('\n  ✓ Cookies saved — you won\'t need to do this again until they expire.\n');
  await pause();
}

// ── main flow ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
  loadCache();

  // ── STEP 1: cookies ──────────────────────────────────────────────────────
  if (!loadCookies()) {
    await cookieSetup('No cookies found. You need to set these up before continuing.');
    loadCookies();
  }

  // ── STEP 2: detect input files ───────────────────────────────────────────
  header('Duel Clipping — Instagram View Tracker');

  const { submissions, sheet1, all } = detectInputFiles();

  console.log('  HOW TO EXPORT CSVs FROM GOOGLE SHEETS:');
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  1. Open the Google Sheet in your browser');
  console.log('  2. Click File → Download → Comma Separated Values (.csv)');
  console.log('  3. Do this for BOTH sheets:');
  console.log('       • duel-post-submission-history  (the submissions tab)');
  console.log('       • Sheet1                        (the views tracking tab)');
  console.log('  4. Move both downloaded .csv files into the "input" folder');
  console.log('     next to this program\n');
  console.log(`  Input folder: ${INPUT_DIR}\n`);
  console.log('  ─────────────────────────────────────────────────────────────\n');

  if (!submissions || !sheet1) {
    console.log('  ✗ Could not find required files in input/\n');
    if (!submissions) console.log('    Missing: submission history CSV  (should contain "source_message_id" column)');
    if (!sheet1)      console.log('    Missing: Sheet1 CSV              (should contain "views_w*" columns)');
    console.log('\n  Add both files to the input/ folder and re-run.\n');
    await pause('Press Enter to exit...');
    process.exit(1);
  }

  console.log(`  ✓ Submissions : ${submissions}`);
  console.log(`  ✓ View sheet  : ${sheet1}\n`);

  // ── STEP 3: parse both files ─────────────────────────────────────────────
  const subs   = parseCSV(fs.readFileSync(path.join(INPUT_DIR, submissions), 'utf8'));
  const views  = parseCSV(fs.readFileSync(path.join(INPUT_DIR, sheet1), 'utf8'));

  const colWeek     = subs.headers.find(h => h === 'week') || 'week';
  const colPlatform = subs.headers.find(h => h === 'platform') || 'platform';
  const colPostLink = subs.headers.find(h => h.includes('post_link') || h.includes('post link')) || 'post_link';

  // ── STEP 4: week filter ──────────────────────────────────────────────────
  const weeks = availableWeeks(subs.rows, colWeek);
  console.log('  Weeks found in submissions:');
  weeks.forEach(w => {
    const count = subs.rows.filter(r => r[colWeek] === w && r[colPlatform] === 'Instagram').length;
    console.log(`    ${w}  (${count} Instagram posts)`);
  });
  console.log('');

  let weekFilter = await ask('Enter week to scan (e.g. 2026-W22) or press Enter for ALL', 'ALL');
  weekFilter = weekFilter.trim().toUpperCase() === 'ALL' ? null : weekFilter.trim();
  console.log('');

  // ── STEP 5: target column ────────────────────────────────────────────────
  const detected     = detectNextViewsColumn(views.headers);
  const existingCols = views.headers.filter(h => /^views_w?\d+$/i.test(h));

  console.log(`  Existing columns : ${existingCols.join('  →  ') || '(none yet)'}`);
  console.log(`  Next column      : ${detected.col}`);
  console.log('');
  console.log(`  [1] This week — add ${detected.col} (new column)`);
  console.log(`  [2] Backfill  — fill missing cells in an existing column`);
  console.log('');

  const modeChoice = await choose('Choose mode', [{ key: '1', label: '' }, { key: '2', label: '' }]);
  console.log('');

  let targetCol;
  let backfillMode = false;

  if (modeChoice === '1') {
    targetCol = detected.col;
    console.log(`  ✓ Writing to new column: ${targetCol}\n`);
  } else {
    backfillMode = true;
    if (!existingCols.length) {
      console.log('  ✗ No existing columns to backfill.\n');
      await pause('Press Enter to exit...');
      process.exit(1);
    }
    console.log('  Which column to backfill?\n');
    existingCols.forEach((c, i) => {
      const missing = views.rows.filter(r => r['platform'] === 'Instagram' && (!r[c] || r[c] === '0')).length;
      console.log(`  [${i + 1}] ${c}   (${missing} Instagram rows with no data)`);
    });
    console.log('');
    let pick = null;
    while (!pick) {
      const ans = await ask('Enter number');
      const idx = parseInt(ans) - 1;
      if (!isNaN(idx) && existingCols[idx]) pick = existingCols[idx];
      else console.log('  Invalid choice, try again.\n');
    }
    targetCol = pick;
    console.log(`\n  ✓ Backfilling missing cells in: ${targetCol}\n`);
  }

  // Add column to sheet1 if it doesn't exist
  let isNewCol = false;
  if (!views.headers.includes(targetCol)) {
    views.headers.push(targetCol);
    views.rows.forEach(r => { if (r[targetCol] === undefined) r[targetCol] = ''; });
    isNewCol = true;
    console.log(`\n  ✓ New column "${targetCol}" will be added to Sheet1`);
  } else {
    console.log(`\n  ✓ Will write to existing column "${targetCol}"`);
  }

  // Previous column for delta display
  const prevColIdx = existingCols.length > 0 ? existingCols[existingCols.length - 1] : null;
  const prevCol    = (!isNewCol && prevColIdx) ? prevColIdx
                   : (detected.prev && views.headers.includes(detected.prev)) ? detected.prev : null;

  console.log('');

  // ── STEP 6: find target rows ─────────────────────────────────────────────
  // Build lookup: normalised post_link → sheet1 row
  const normUrl = u => (u || '').split('?')[0].replace(/\/$/, '').toLowerCase();
  const sheet1Map = new Map();
  for (const row of views.rows) {
    const key = normUrl(row['post_link'] || row['Post Link'] || '');
    if (key) sheet1Map.set(key, row);
  }

  // Filter submission rows
  const igSubs = subs.rows.filter(r => {
    if (r[colPlatform] !== 'Instagram') return false;
    if (weekFilter && r[colWeek] !== weekFilter) return false;
    return !!stripShortcode(r[colPostLink]);
  });

  // Classify each
  const toFetch = [], alreadyDone = [], notInSheet1 = [];

  for (const row of igSubs) {
    const key  = normUrl(row[colPostLink]);
    const s1   = sheet1Map.get(key);
    if (!s1) {
      notInSheet1.push(row);
    } else {
      const val = (s1[targetCol] || '').trim();
      if (!val || val === '0') {
        toFetch.push({ subRow: row, s1Row: s1 });
      } else {
        alreadyDone.push(row);
      }
    }
  }

  console.log(hr());
  console.log('');
  console.log(`  Total Instagram submissions matched : ${igSubs.length}`);
  console.log(`  Already have "${targetCol}"          : ${alreadyDone.length}`);
  console.log(`  Not in Sheet1 (will skip)           : ${notInSheet1.length}`);
  console.log(`  To fetch                            : ${toFetch.length}`);
  console.log('');

  if (!toFetch.length) {
    console.log('  Nothing to fetch — all matching rows already have data.\n');
    await pause('Press Enter to exit...');
    process.exit(0);
  }

  const go = await ask(`  Fetch ${toFetch.length} reels now? (y/n)`, 'y');
  if (go.toLowerCase() !== 'y') { console.log('\n  Cancelled.\n'); process.exit(0); }

  // ── STEP 7: run label for cache ──────────────────────────────────────────
  const runLabel = `${weekFilter || 'ALL'}::${targetCol}`;

  console.log('\n' + hr());
  console.log('');

  let fetched = 0, succeeded = 0, deleted = 0, broken = 0, authFailStreak = 0;

  for (const { subRow, s1Row } of toFetch) {
    fetched++;
    const shortcode = stripShortcode(subRow[colPostLink]);
    const pad       = String(fetched).padStart(String(toFetch.length).length);
    const key       = cacheKey(runLabel, shortcode);

    // Resume from cache
    if (cache[key] !== undefined) {
      s1Row[targetCol] = String(cache[key]);
      process.stdout.write(`  [${pad}/${toFetch.length}] ${shortcode.padEnd(14)} → `);
      console.log(`${String(cache[key]).padStart(12)} (cached)`);
      succeeded++;
      continue;
    }

    process.stdout.write(`  [${pad}/${toFetch.length}] ${shortcode.padEnd(14)} → `);

    const result = await fetchViews(shortcode);

    if (result.authFail) {
      const isRedirect = !!result.redirect;
      if (!isRedirect) authFailStreak++;

      if (isRedirect || authFailStreak >= 2) {
        console.log(isRedirect ? 'REDIRECTED (302)' : 'AUTH FAILED');
        console.log('');
        fs.writeFileSync(path.join(OUTPUT_DIR, 'Sheet1_updated.csv'), serializeCSV(views.headers, views.rows));
        saveCache();
        const reason = isRedirect
          ? 'Instagram returned a 302 redirect — your session has expired. Re-enter your cookies to continue.'
          : 'Instagram rejected your cookies — they may have expired. Re-enter them to continue.';
        await cookieSetup(reason);
        loadCookies();
        authFailStreak = 0;
      }
      // Retry this reel
      fetched--;
      continue;
    }

    authFailStreak = 0;

    if (result.views !== null) {
      const label = String(result.views);
      s1Row[targetCol] = label;
      cache[key] = label;
      succeeded++;

      const prev = prevCol ? Number(s1Row[prevCol]) : null;
      const delta = (prev && prev > 0 && result.views > 0)
        ? `  (${result.views - prev >= 0 ? '+' : ''}${(result.views - prev).toLocaleString()} vs ${prevCol})`
        : '';
      console.log(`${result.views.toLocaleString().padStart(12)} views${delta}`);
    } else {
      const isGone = result.gone || /not_found|media_not_found|404/i.test(result.error || '');
      const label  = isGone ? 'DELETED' : 'BROKEN';
      s1Row[targetCol] = label;
      cache[key] = label;
      isGone ? deleted++ : broken++;
      console.log(`${label.padStart(12)}  (${result.error})`);
    }

    // Save output + cache after every fetch — never lose progress
    fs.writeFileSync(path.join(OUTPUT_DIR, 'Sheet1_updated.csv'), serializeCSV(views.headers, views.rows));
    saveCache();

    if (fetched < toFetch.length) await sleep(2000 + Math.random() * 1000);
  }

  // ── STEP 8: final output ─────────────────────────────────────────────────
  const outFile = path.join(OUTPUT_DIR, 'Sheet1_updated.csv');
  fs.writeFileSync(outFile, serializeCSV(views.headers, views.rows));
  saveCache();

  console.log('');
  console.log(hr());
  console.log('');
  console.log(`  ✓ Complete`);
  console.log(`    Fetched   : ${succeeded}`);
  console.log(`    Deleted   : ${deleted}`);
  console.log(`    Broken    : ${broken}`);
  console.log('');
  console.log(`  ✓ Updated Sheet1 saved to:`);
  console.log(`    ${outFile}`);
  console.log('');
  console.log('  Upload Sheet1_updated.csv back to Google Sheets:');
  console.log('  File → Import → Upload → Replace current sheet');
  console.log('');
  await pause('Press Enter to exit...');
}

main().catch(e => {
  console.error('\n  ✗ Unexpected error:', e.message);
  console.error('  Please screenshot this and send to your admin.\n');
  process.exitCode = 1;
});
