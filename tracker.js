'use strict';

/**
 * Duel Clipping — Instagram View Tracker (multi-cookie edition)
 *
 * Reads two CSVs from input/:
 *   - Submission history (duel-post-submission-history...)
 *   - View sheet (Sheet1...)
 *
 * Cookie accounts go in cookies/ folder as cookies_1.txt, cookies_2.txt, etc.
 * Each account runs as its own parallel worker → N× speed with N accounts.
 *
 * Output → output/Sheet1_updated.csv
 */

const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ── paths ─────────────────────────────────────────────────────────────────────
const DIR         = __dirname;
const INPUT_DIR   = path.join(DIR, 'input');
const OUTPUT_DIR  = path.join(DIR, 'output');
const COOKIES_DIR = path.join(DIR, 'cookies');
const CACHE_FILE  = path.join(DIR, 'cache.json');

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

// ── cache ─────────────────────────────────────────────────────────────────────
let cache = {};
const cacheLock = { writing: false };

function loadCache() {
  if (fs.existsSync(CACHE_FILE)) {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    try {
      cache = JSON.parse(raw);
      console.log(`  ✓ Cache loaded: ${Object.keys(cache).length} entries`);
    } catch (e) {
      console.error(`\n  ✗ cache.json corrupted: ${e.message}`);
      console.error('  Fix or delete cache.json first.\n');
      process.exit(1);
    }
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function cacheKey(runLabel, shortcode) { return `${runLabel}::${shortcode}`; }

// ── cookie pool ───────────────────────────────────────────────────────────────
function parseCookieFile(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return obj;
}

function cookieStr(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function loadCookiePool() {
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR);

  // Support both cookies_1.txt style and legacy cookies.txt in root
  const pool = [];

  const rootCookies = path.join(DIR, 'cookies.txt');
  if (fs.existsSync(rootCookies)) {
    const c = parseCookieFile(fs.readFileSync(rootCookies, 'utf8'));
    if (c.sessionid && c.csrftoken && c.ds_user_id) {
      pool.push({ id: 'account_0', cookies: c, file: rootCookies });
    }
  }

  const files = fs.readdirSync(COOKIES_DIR)
    .filter(f => f.endsWith('.txt'))
    .sort();

  for (const f of files) {
    const c = parseCookieFile(fs.readFileSync(path.join(COOKIES_DIR, f), 'utf8'));
    if (c.sessionid && c.csrftoken && c.ds_user_id) {
      pool.push({ id: f.replace('.txt', ''), cookies: c, file: path.join(COOKIES_DIR, f) });
    }
  }

  return pool;
}

function saveCookieAccount(accountId, cookies) {
  const file = path.join(COOKIES_DIR, `${accountId}.txt`);
  fs.writeFileSync(file, Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('\n'));
  return file;
}

// ── terminal helpers ──────────────────────────────────────────────────────────
const W = 64;
const hr = (c = '─') => c.repeat(W);

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

function fetchViews(shortcode, cookies) {
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
        'Cookie'     : cookieStr(cookies),
      },
    }, res => {
      if (res.statusCode === 302) {
        res.resume();
        resolve({ views: null, authFail: true, redirect: true, error: '302 redirect (session expired)' });
        return;
      }
      const status = res.statusCode;
      // Any non-2xx that isn't a known "post gone" signal = rate limit / error pause
      const isRateLimit = status === 429;
      const isClientErr = status >= 400 && status !== 404 && status !== 410;
      if (isRateLimit || (isClientErr && status !== 401 && status !== 403)) {
        res.resume();
        resolve({ views: null, authFail: false, rateLimited: true, error: `HTTP ${status}` });
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
            const authFail = status === 401 || status === 403 || authMsg;
            const gone     = /not_found|media_not_found|deleted/i.test(data?.message || '');
            resolve({ views: null, authFail, gone, error: data?.message || `HTTP ${status}` });
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
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim());
  for (const line of lines) {
    const lower = line.toLowerCase();
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

// ── cookie setup ──────────────────────────────────────────────────────────────
async function cookieSetup(accountId, reason = '') {
  console.log('\n' + hr());
  if (reason) console.log(`\n  ⚠  ${reason}\n`);
  console.log(`\n  Setting up cookies for: ${accountId}`);
  console.log('\n  HOW TO GET COOKIES:');
  console.log('  1. Open Chrome → instagram.com → log in');
  console.log('  2. F12 → Application → Cookies → https://www.instagram.com');
  console.log('  3. Copy: sessionid, csrftoken, ds_user_id\n');

  const cookies = {};
  cookies.sessionid  = await ask('Paste sessionid');
  cookies.csrftoken  = await ask('Paste csrftoken');
  cookies.ds_user_id = await ask('Paste ds_user_id');

  const file = saveCookieAccount(accountId, cookies);
  console.log(`\n  ✓ Saved to ${file}\n`);
  return cookies;
}

// ── shared output state ───────────────────────────────────────────────────────
// Workers write to this atomically-ish via saveSharedOutput
let sharedViews = null;
let saveQueued = false;

function saveSharedOutput() {
  if (saveQueued) return;
  saveQueued = true;
  setImmediate(() => {
    saveQueued = false;
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'Sheet1_updated.csv'),
      serializeCSV(sharedViews.headers, sharedViews.rows)
    );
    saveCache();
  });
}

// ── worker ────────────────────────────────────────────────────────────────────
async function runWorker(account, queue, runLabel, prevCol, stats, log) {
  let { cookies } = account;
  let authFailStreak = 0;

  while (true) {
    // Atomically grab next item
    const item = queue.shift();
    if (!item) break;

    const { subRow, s1Row, shortcode, index, total } = item;
    const key = cacheKey(runLabel, shortcode);

    // Cache hit
    if (cache[key] !== undefined) {
      s1Row[targetCol] = String(cache[key]);
      stats.succeeded++;
      log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → ${String(cache[key]).padStart(12)} (cached)`);
      saveSharedOutput();
      continue;
    }

    log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → fetching...`);

    const result = await fetchViews(shortcode, cookies);

    if (result.rateLimited) {
      queue.unshift(item);
      log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → PAUSED (${result.error}) — backing off 15s`);
      await sleep(15000);
      continue;
    }

    if (result.authFail) {
      authFailStreak++;
      log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → AUTH FAILED (streak: ${authFailStreak})`);

      if (authFailStreak >= 2 || result.redirect) {
        queue.unshift(item);
        const reason = result.redirect
          ? `Account ${account.id}: session expired (302 redirect)`
          : `Account ${account.id}: cookies rejected by Instagram`;
        cookies = await cookieSetup(account.id, reason);
        account.cookies = cookies;
        authFailStreak = 0;
      }
      await sleep(1000);
      continue;
    }

    authFailStreak = 0;

    if (result.views !== null) {
      const label = String(result.views);
      s1Row[targetCol] = label;
      cache[key] = label;
      stats.succeeded++;

      const prev  = prevCol ? Number(s1Row[prevCol]) : null;
      const delta = (prev && prev > 0 && result.views > 0)
        ? `  (${result.views - prev >= 0 ? '+' : ''}${(result.views - prev).toLocaleString()} vs ${prevCol})`
        : '';
      log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → ${result.views.toLocaleString().padStart(12)} views${delta}`);
    } else {
      const isGone = result.gone || /not_found|media_not_found|404/i.test(result.error || '');
      const label  = isGone ? 'DELETED' : 'BROKEN';
      s1Row[targetCol] = label;
      cache[key] = label;
      isGone ? stats.deleted++ : stats.broken++;
      log(`[${index}/${total}] ${account.id.padEnd(12)} ${shortcode.padEnd(14)} → ${label.padStart(12)}  (${result.error})`);
    }

    saveSharedOutput();

    // Per-worker rate limit delay — floor 900ms, random jitter up to +600ms
    await sleep(900 + Math.random() * 600);
  }
}

// targetCol is set during main and used by workers
let targetCol = '';

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);
  if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR);
  loadCache();

  // ── cookie pool setup ────────────────────────────────────────────────────
  console.log('\n' + hr('━'));
  console.log('  Duel Clipping — Instagram View Tracker (multi-account)');
  console.log(hr('━'));

  let pool = loadCookiePool();

  if (pool.length) {
    console.log(`\n  Found ${pool.length} saved account(s): ${pool.map(a => a.id).join(', ')}`);
    const reuse = await ask('Use saved accounts? (y) or re-enter all? (n)', 'y');
    if (reuse.toLowerCase() !== 'y') pool = [];
  }

  if (!pool.length) {
    console.log('');
    let count = 0;
    while (count < 1 || isNaN(count)) {
      const ans = await ask('How many Instagram accounts do you want to use?');
      count = parseInt(ans);
      if (isNaN(count) || count < 1) console.log('  Enter a number >= 1.\n');
    }
    console.log('');
    for (let i = 1; i <= count; i++) {
      console.log(`  — Account ${i} of ${count} —`);
      const id = `cookies_${i}`;
      const cookies = await cookieSetup(id);
      pool.push({ id, cookies, file: path.join(COOKIES_DIR, `${id}.txt`) });
      console.log('');
    }
  }

  console.log(`  ✓ ${pool.length} account(s) ready: ${pool.map(a => a.id).join(', ')}`);
  console.log(`  ✓ Expected speed: ~${pool.length}× faster than single-account\n`);

  // ── detect input files ───────────────────────────────────────────────────
  const { submissions, sheet1 } = detectInputFiles();

  if (!submissions || !sheet1) {
    console.log('  ✗ Could not find required CSVs in input/\n');
    if (!submissions) console.log('    Missing: submission history CSV');
    if (!sheet1)      console.log('    Missing: Sheet1 CSV');
    console.log(`\n  Add both files to: ${INPUT_DIR}\n`);
    await pause('Press Enter to exit...');
    process.exit(1);
  }

  console.log(`  ✓ Submissions : ${submissions}`);
  console.log(`  ✓ View sheet  : ${sheet1}\n`);

  // ── parse ────────────────────────────────────────────────────────────────
  const subs  = parseCSV(fs.readFileSync(path.join(INPUT_DIR, submissions), 'utf8'));
  const views = parseCSV(fs.readFileSync(path.join(INPUT_DIR, sheet1), 'utf8'));

  sharedViews = views;

  const colWeek     = subs.headers.find(h => h === 'week') || 'week';
  const colPlatform = subs.headers.find(h => h === 'platform') || 'platform';
  const colPostLink = subs.headers.find(h => h.includes('post_link') || h.includes('post link')) || 'post_link';

  // ── week filter ──────────────────────────────────────────────────────────
  const weeks = availableWeeks(subs.rows, colWeek);
  console.log('  Weeks found:');
  weeks.forEach(w => {
    const count = subs.rows.filter(r => r[colWeek] === w && r[colPlatform] === 'Instagram').length;
    console.log(`    ${w}  (${count} Instagram posts)`);
  });
  console.log('');

  let weekFilter = await ask('Week to scan (e.g. 2026-W22) or Enter for ALL', 'ALL');
  weekFilter = weekFilter.trim().toUpperCase() === 'ALL' ? null : weekFilter.trim();
  console.log('');

  // ── target column ────────────────────────────────────────────────────────
  const detected     = detectNextViewsColumn(views.headers);
  const existingCols = views.headers.filter(h => /^views_w?\d+$/i.test(h));

  console.log(`  Existing columns : ${existingCols.join('  →  ') || '(none yet)'}`);
  console.log(`  Next column      : ${detected.col}\n`);
  console.log(`  [1] This week — add ${detected.col}`);
  console.log('  [2] Backfill  — fill missing cells in existing column\n');

  const modeChoice = await choose('Choose mode', [{ key: '1' }, { key: '2' }]);
  console.log('');

  let backfillMode = false;

  if (modeChoice === '1') {
    targetCol = detected.col;
    console.log(`  ✓ Writing to new column: ${targetCol}\n`);
  } else {
    backfillMode = true;
    if (!existingCols.length) {
      console.log('  ✗ No existing columns to backfill.\n');
      process.exit(1);
    }
    existingCols.forEach((c, i) => {
      const missing = views.rows.filter(r => r['platform'] === 'Instagram' && (!r[c] || r[c] === '0')).length;
      console.log(`  [${i + 1}] ${c}   (${missing} missing)`);
    });
    console.log('');
    let pick = null;
    while (!pick) {
      const ans = await ask('Enter number');
      const idx = parseInt(ans) - 1;
      if (!isNaN(idx) && existingCols[idx]) pick = existingCols[idx];
      else console.log('  Invalid choice.\n');
    }
    targetCol = pick;
    console.log(`\n  ✓ Backfilling: ${targetCol}\n`);
  }

  if (!views.headers.includes(targetCol)) {
    views.headers.push(targetCol);
    views.rows.forEach(r => { if (r[targetCol] === undefined) r[targetCol] = ''; });
    console.log(`  ✓ New column "${targetCol}" added\n`);
  }

  const prevColIdx = existingCols[existingCols.length - 1];
  const prevCol    = (detected.prev && views.headers.includes(detected.prev)) ? detected.prev
                   : (prevColIdx && prevColIdx !== targetCol) ? prevColIdx : null;

  // ── build work queue ─────────────────────────────────────────────────────
  const normUrl = u => (u || '').split('?')[0].replace(/\/$/, '').toLowerCase();
  const sheet1Map = new Map();
  for (const row of views.rows) {
    const key = normUrl(row['post_link'] || row['Post Link'] || '');
    if (key) sheet1Map.set(key, row);
  }

  const igSubs = subs.rows.filter(r => {
    if (r[colPlatform] !== 'Instagram') return false;
    if (weekFilter && r[colWeek] !== weekFilter) return false;
    return !!stripShortcode(r[colPostLink]);
  });

  const toFetch = [], alreadyDone = [], notInSheet1 = [];
  for (const row of igSubs) {
    const key = normUrl(row[colPostLink]);
    const s1  = sheet1Map.get(key);
    if (!s1) {
      notInSheet1.push(row);
    } else {
      const val = (s1[targetCol] || '').trim();
      if (!val || val === '0') toFetch.push({ subRow: row, s1Row: s1 });
      else alreadyDone.push(row);
    }
  }

  console.log(hr());
  console.log(`\n  Total IG submissions : ${igSubs.length}`);
  console.log(`  Already done         : ${alreadyDone.length}`);
  console.log(`  Not in Sheet1        : ${notInSheet1.length}`);
  console.log(`  To fetch             : ${toFetch.length}`);
  console.log(`  Workers (accounts)   : ${pool.length}`);
  if (toFetch.length > 0) {
    const perWorker  = Math.ceil(toFetch.length / pool.length);
    const estSecs    = perWorker * 2.5;
    const estMins    = Math.ceil(estSecs / 60);
    console.log(`  Est. time           : ~${estMins} min  (vs ~${Math.ceil(toFetch.length * 2.5 / 60)} min single-account)`);
  }
  console.log('');

  if (!toFetch.length) {
    console.log('  Nothing to fetch — all rows already have data.\n');
    await pause('Press Enter to exit...');
    process.exit(0);
  }

  const go = await ask(`  Fetch ${toFetch.length} reels with ${pool.length} account(s) now? (y/n)`, 'y');
  if (go.toLowerCase() !== 'y') { console.log('\n  Cancelled.\n'); process.exit(0); }

  // ── build queue with index labels ────────────────────────────────────────
  const runLabel = `${weekFilter || 'ALL'}::${targetCol}`;
  const queue = toFetch.map((item, i) => ({
    ...item,
    shortcode: stripShortcode(item.subRow[colPostLink]),
    index: i + 1,
    total: toFetch.length,
  }));

  console.log('\n' + hr());
  console.log('');

  const stats = { succeeded: 0, deleted: 0, broken: 0 };
  const logMu = [];
  const log = msg => { console.log('  ' + msg); };

  // ── launch workers in parallel ───────────────────────────────────────────
  // Stagger start by 500ms per worker to avoid bursting all at once
  const workerPromises = pool.map((account, i) =>
    sleep(i * 500).then(() => runWorker(account, queue, runLabel, prevCol, stats, log))
  );

  await Promise.all(workerPromises);

  // ── final save ───────────────────────────────────────────────────────────
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'Sheet1_updated.csv'),
    serializeCSV(views.headers, views.rows)
  );
  saveCache();

  console.log('');
  console.log(hr());
  console.log(`\n  ✓ Complete`);
  console.log(`    Fetched   : ${stats.succeeded}`);
  console.log(`    Deleted   : ${stats.deleted}`);
  console.log(`    Broken    : ${stats.broken}`);
  console.log(`\n  ✓ Saved to: ${path.join(OUTPUT_DIR, 'Sheet1_updated.csv')}\n`);
  console.log('  Upload back to Google Sheets:');
  console.log('  File → Import → Upload → Replace current sheet\n');
  await pause('Press Enter to exit...');
}

main().catch(e => {
  console.error('\n  ✗ Unexpected error:', e.message);
  console.error(e.stack);
  process.exitCode = 1;
});
