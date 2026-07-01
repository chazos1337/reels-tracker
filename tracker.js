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

// ── color ─────────────────────────────────────────────────────────────────────
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const codes = { bold: 1, red: 31, green: 32, yellow: 33, white: 37, cyan: 36, gray: 90 };
const paint = (name, s) => useColor ? `\x1b[${codes[name]}m${s}\x1b[0m` : String(s);
const ok      = s => paint('green', s);
const warn    = s => paint('yellow', s);
const err     = s => paint('red', s);
const info    = s => paint('cyan', s);
const white   = s => paint('white', s);
const dimTxt  = s => paint('gray', s);
const bold    = s => paint('bold', s);

// ── banner ────────────────────────────────────────────────────────────────────
// Old-school 5-row block-letter font, hand-built — just enough glyphs to spell
// the logo below.
const BANNER_FONT = {
  D: ['████ ', '█   █', '█   █', '█   █', '████ '],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
  '.': ['  ', '  ', '  ', '  ', '██'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
};

function printBanner() {
  const glyphs = [...'DUEL.COM'].map(ch => BANNER_FONT[ch]);
  console.log('');
  for (let r = 0; r < 5; r++) {
    console.log('   ' + bold(white(glyphs.map(g => g[r]).join('  '))));
  }
  console.log('');
}

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
      console.log(dimTxt(`  ✓ Cache loaded: ${Object.keys(cache).length} entries`));
    } catch (e) {
      console.error(err(`\n  ✗ cache.json corrupted: ${e.message}`));
      console.error(err('  Fix or delete cache.json first.\n'));
      process.exit(1);
    }
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function cacheKey(runLabel, shortcode) { return `${runLabel}::${shortcode}`; }

// ── cookie pool ───────────────────────────────────────────────────────────────
// Handles both the stored cookies_N.txt format (one "key=value" per line) and
// a pasted browser "Cookie:" request header (one long "key=value; key2=value2" line).
function parseCookieBlob(text) {
  const obj = {};
  for (const part of (text || '').split(/[\n;]+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) obj[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
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
    const c = parseCookieBlob(fs.readFileSync(rootCookies, 'utf8'));
    if (c.sessionid && c.csrftoken && c.ds_user_id) {
      pool.push({ id: 'account_0', cookies: c, file: rootCookies });
    }
  }

  const files = fs.readdirSync(COOKIES_DIR)
    .filter(f => f.endsWith('.txt') && f.toLowerCase() !== 'readme.txt')
    .sort();

  for (const f of files) {
    const c = parseCookieBlob(fs.readFileSync(path.join(COOKIES_DIR, f), 'utf8'));
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
const hr = (c = '─') => dimTxt(c.repeat(W));

function ask(q, def) {
  const hint = def !== undefined ? dimTxt(` [${def}]`) : '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  ${info('?')} ${q}${hint}: `, ans => {
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
      console.log(err('  Invalid choice, try again.\n'));
    }
  });
}

async function pause(msg = 'Press Enter to continue...') { await ask(msg); }

// ── IG API ────────────────────────────────────────────────────────────────────
function stripShortcode(url) {
  const m = (url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:reels?|p)\/([A-Za-z0-9_-]+)/);
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
      // Any non-2xx that isn't a known "post gone"/"bad request" signal = rate limit / error pause.
      // 400 is excluded here — Instagram returns it for deleted/inaccessible media (not rate limiting),
      // so it needs its body read below instead of being blindly requeued forever.
      const isRateLimit = status === 429;
      const isClientErr = status >= 400 && status !== 400 && status !== 404 && status !== 410;
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
            const gone     = status === 400 || status === 404 || status === 410 ||
                              /not[_ ]?found|media_not_found|deleted|unavailable|does not exist/i.test(data?.message || '');
            resolve({ views: null, authFail, gone, error: data?.message || `HTTP ${status}` });
          }
        } catch {
          // 400 with an unparsable body is still a deleted/inaccessible reel, not a parse failure worth retrying
          resolve({ views: null, authFail: false, gone: status === 400, error: status === 400 ? 'HTTP 400 (deleted or inaccessible)' : 'parse error' });
        }
      });
    });
    req.on('error', e => resolve({ views: null, authFail: false, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ views: null, authFail: false, error: 'timeout' }); });
    req.end();
  });
}

// Cheap "is this session still alive" probe. Reuses fetchViews() — the
// battle-tested request path — against a throwaway media id instead of
// inventing a second endpoint with its own auth/parsing quirks. We don't
// care whether that id resolves to a real post: Instagram evaluates the
// session before it evaluates whether the post exists, so a dead session
// fails with authFail regardless of the target, and a live session just
// gets a normal "not found" for the fake id (authFail: false).
async function checkSession(cookies) {
  const result = await fetchViews('C0000000000', cookies);
  return result.authFail ? { alive: false, error: result.error } : { alive: true };
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
    } else if (header.includes('source_message_id') || header.includes('submission_id')) {
      submissions = f;
    }
  }

  // Combined export: one CSV can serve as both submissions and views sheet
  // if it already carries post_link/platform alongside the views_wN columns.
  if (!submissions && sheet1) {
    const header = sniffHeader(fs.readFileSync(path.join(INPUT_DIR, sheet1), 'utf8'));
    if (header.includes('post_link') && header.includes('platform')) {
      submissions = sheet1;
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
const REQUIRED_COOKIE_KEYS = ['sessionid', 'csrftoken', 'ds_user_id'];

async function cookieSetup(accountId, reason = '') {
  console.log('\n' + hr());
  if (reason) console.log(`\n  ${warn('⚠')}  ${warn(reason)}\n`);
  console.log(`\n  Setting up cookies for: ${bold(accountId)}`);
  console.log(dimTxt('\n  HOW TO GET YOUR COOKIE:'));
  console.log(dimTxt('  1. Log into instagram.com in Chrome'));
  console.log(dimTxt('  2. Press F12, click the "Network" tab, then refresh the page (F5)'));
  console.log(dimTxt('  3. Click any request to instagram.com in the list, then click "Headers" on the right'));
  console.log(dimTxt('  4. Under "Request Headers", find the row named "cookie"'));
  console.log(dimTxt('  5. Right-click it → "Copy value"'));
  console.log(dimTxt('  6. Paste it below and press Enter\n'));

  let cookies = {};
  while (true) {
    const pasted = await ask('Paste the cookie value here');
    cookies = parseCookieBlob(pasted);
    const missing = REQUIRED_COOKIE_KEYS.filter(k => !cookies[k]);
    if (!missing.length) break;

    console.log(err(`\n  ✗ Couldn't find ${missing.join(', ')} in what you pasted.`));
    console.log(dimTxt('  Make sure you right-clicked the "cookie" row itself and chose "Copy value".\n'));
    const retry = await ask('  Try pasting again? (y) or enter the 3 values one at a time instead? (n)', 'y');
    if (retry.toLowerCase() !== 'y') {
      cookies = {};
      cookies.sessionid  = await ask('Paste sessionid');
      cookies.csrftoken  = await ask('Paste csrftoken');
      cookies.ds_user_id = await ask('Paste ds_user_id');
      break;
    }
    console.log('');
  }

  const file = saveCookieAccount(accountId, cookies);
  console.log(ok(`\n  ✓ Saved to ${file}\n`));
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

    const tag = `${dimTxt(`[${String(index).padStart(String(total).length)}/${total}]`)} ${info(account.id.padEnd(12))} ${shortcode.padEnd(14)}`;

    // Cache hit
    if (cache[key] !== undefined) {
      s1Row[targetCol] = String(cache[key]);
      stats.succeeded++;
      log(`${tag} → ${dimTxt(String(cache[key]).padStart(12) + ' (cached)')}`);
      saveSharedOutput();
      continue;
    }

    log(`${tag} → ${dimTxt('fetching...')}`);

    const result = await fetchViews(shortcode, cookies);

    if (result.rateLimited) {
      queue.unshift(item);
      log(`${tag} → ${warn(`PAUSED (${result.error}) — backing off 15s`)}`);
      await sleep(15000);
      continue;
    }

    if (result.authFail) {
      authFailStreak++;
      log(`${tag} → ${err(`AUTH FAILED (streak: ${authFailStreak})`)}`);

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
        ? `  ${dimTxt(`(${result.views - prev >= 0 ? '+' : ''}${(result.views - prev).toLocaleString()} vs ${prevCol})`)}`
        : '';
      log(`${tag} → ${ok(result.views.toLocaleString().padStart(12) + ' views')}${delta}`);
    } else {
      const isGone = result.gone || /not_found|media_not_found|404/i.test(result.error || '');
      const label  = isGone ? 'DELETED' : 'BROKEN';
      s1Row[targetCol] = label;
      cache[key] = label;
      isGone ? stats.deleted++ : stats.broken++;
      const paintFn = isGone ? warn : err;
      log(`${tag} → ${paintFn(label.padStart(12))}  ${dimTxt(`(${result.error})`)}`);
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

  printBanner();

  // ── cookie pool setup ────────────────────────────────────────────────────
  console.log('\n' + hr('━'));
  console.log(bold('  Instagram View Tracker (multi-account)'));
  console.log(hr('━'));

  let pool = loadCookiePool();

  if (pool.length) {
    console.log(`\n  Found ${bold(pool.length)} saved account(s): ${info(pool.map(a => a.id).join(', '))}`);
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

  // ── session liveness check ───────────────────────────────────────────────
  // Catch a dead cookie now, before the queue is even built, instead of
  // discovering it partway through a run when that worker's first fetch fails.
  console.log(dimTxt('\n  Checking sessions...'));
  for (const account of pool) {
    const status = await checkSession(account.cookies);
    if (status.alive) {
      console.log(ok(`  ✓ ${account.id.padEnd(12)} session OK`));
    } else {
      console.log(warn(`  ⚠ ${account.id.padEnd(12)} session expired or invalid (${status.error || 'unknown'})`));
      account.cookies = await cookieSetup(account.id, `Account ${account.id}: session expired — needs fresh cookies before we can start`);
    }
  }
  console.log('');

  console.log(ok(`  ✓ ${pool.length} account(s) ready: ${pool.map(a => a.id).join(', ')}`));
  console.log(ok(`  ✓ Expected speed: ~${pool.length}× faster than single-account\n`));

  // ── detect input files ───────────────────────────────────────────────────
  const { submissions, sheet1 } = detectInputFiles();

  if (!submissions || !sheet1) {
    console.log(err('  ✗ Could not find required CSVs in input/\n'));
    if (!submissions) console.log(err('    Missing: submission history CSV'));
    if (!sheet1)      console.log(err('    Missing: Sheet1 CSV'));
    console.log(`\n  Add both files to: ${INPUT_DIR}\n`);
    await pause('Press Enter to exit...');
    process.exit(1);
  }

  console.log(ok(`  ✓ Submissions : ${submissions}`));
  console.log(ok(`  ✓ View sheet  : ${sheet1}\n`));

  // ── parse ────────────────────────────────────────────────────────────────
  const subs  = parseCSV(fs.readFileSync(path.join(INPUT_DIR, submissions), 'utf8'));
  const views = parseCSV(fs.readFileSync(path.join(INPUT_DIR, sheet1), 'utf8'));

  sharedViews = views;

  const colWeek     = subs.headers.find(h => h === 'week') || 'week';
  const colPlatform = subs.headers.find(h => h === 'platform') || 'platform';
  const colPostLink = subs.headers.find(h => h.includes('post_link') || h.includes('post link')) || 'post_link';

  // ── week filter ──────────────────────────────────────────────────────────
  const weeks = availableWeeks(subs.rows, colWeek);
  console.log(bold('  Weeks found:'));
  weeks.forEach(w => {
    const count = subs.rows.filter(r => r[colWeek] === w && r[colPlatform] === 'Instagram').length;
    console.log(`    ${info(w)}  ${dimTxt(`(${count} Instagram posts)`)}`);
  });
  console.log('');

  let weekFilter = await ask('Week to scan (e.g. 2026-W22) or Enter for ALL', 'ALL');
  weekFilter = weekFilter.trim().toUpperCase() === 'ALL' ? null : weekFilter.trim();
  console.log('');

  // ── target column ────────────────────────────────────────────────────────
  const detected     = detectNextViewsColumn(views.headers);
  const existingCols = views.headers.filter(h => /^views_w?\d+$/i.test(h));

  console.log(`  Existing columns : ${dimTxt(existingCols.join('  →  ') || '(none yet)')}`);
  console.log(`  Next column      : ${info(detected.col)}\n`);
  console.log(`  [1] This week — add ${bold(detected.col)}`);
  console.log('  [2] Backfill  — fill missing cells in existing column\n');

  const modeChoice = await choose('Choose mode', [{ key: '1' }, { key: '2' }]);
  console.log('');

  let backfillMode = false;

  if (modeChoice === '1') {
    targetCol = detected.col;
    console.log(ok(`  ✓ Writing to new column: ${targetCol}\n`));
  } else {
    backfillMode = true;
    if (!existingCols.length) {
      console.log(err('  ✗ No existing columns to backfill.\n'));
      process.exit(1);
    }
    existingCols.forEach((c, i) => {
      const missing = views.rows.filter(r => r['platform'] === 'Instagram' && (!r[c] || r[c] === '0')).length;
      console.log(`  [${i + 1}] ${c}   ${dimTxt(`(${missing} missing)`)}`);
    });
    console.log('');
    let pick = null;
    while (!pick) {
      const ans = await ask('Enter number');
      const idx = parseInt(ans) - 1;
      if (!isNaN(idx) && existingCols[idx]) pick = existingCols[idx];
      else console.log(err('  Invalid choice.\n'));
    }
    targetCol = pick;
    console.log(ok(`\n  ✓ Backfilling: ${targetCol}\n`));
  }

  if (!views.headers.includes(targetCol)) {
    views.headers.push(targetCol);
    views.rows.forEach(r => { if (r[targetCol] === undefined) r[targetCol] = ''; });
    console.log(ok(`  ✓ New column "${targetCol}" added\n`));
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

  // Pre-flight: split candidates into fetchable (has a shortcode) vs. invalid
  // links (profile pages, listing tabs, etc.) so bad data is surfaced up front
  // instead of silently vanishing from the counts.
  const igCandidates = subs.rows.filter(r => {
    if (r[colPlatform] !== 'Instagram') return false;
    if (weekFilter && r[colWeek] !== weekFilter) return false;
    return true;
  });

  const igSubs = [], invalidLinkRows = [];
  for (const r of igCandidates) {
    (stripShortcode(r[colPostLink]) ? igSubs : invalidLinkRows).push(r);
  }

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

  // Invalid links that are sitting in Sheet1 with an empty target cell —
  // these are the ones worth offering to mark BROKEN, since they'll never
  // resolve to a fetchable post.
  const invalidNeedingFix = [];
  for (const row of invalidLinkRows) {
    const key = normUrl(row[colPostLink]);
    const s1  = sheet1Map.get(key);
    if (s1) {
      const val = (s1[targetCol] || '').trim();
      if (!val || val === '0') invalidNeedingFix.push({ subRow: row, s1Row: s1 });
    }
  }

  console.log(hr());
  console.log(bold('\n  Summary'));
  const summaryLine = (label, value, color = s => s) => console.log(`  ${label.padEnd(22)} ${color(String(value))}`);
  summaryLine('Total IG submissions', igCandidates.length);
  summaryLine('Already done',         alreadyDone.length, ok);
  summaryLine('Invalid links',        invalidLinkRows.length, invalidLinkRows.length ? warn : dimTxt);
  summaryLine('Not in Sheet1',        notInSheet1.length, dimTxt);
  summaryLine('To fetch',             toFetch.length, toFetch.length ? bold : dimTxt);
  summaryLine('Workers (accounts)',   pool.length);
  if (toFetch.length > 0) {
    const perWorker  = Math.ceil(toFetch.length / pool.length);
    const estSecs    = perWorker * 2.5;
    const estMins    = Math.ceil(estSecs / 60);
    summaryLine('Est. time', `~${estMins} min  ${dimTxt(`(vs ~${Math.ceil(toFetch.length * 2.5 / 60)} min single-account)`)}`);
  }
  console.log('');

  if (invalidNeedingFix.length) {
    console.log(warn(`  ⚠ ${invalidNeedingFix.length} link(s) aren't a specific post (profile page or "reels" tab) — can't be fetched:`));
    invalidNeedingFix.slice(0, 10).forEach(({ subRow }) => console.log(dimTxt(`    • ${subRow[colPostLink]}`)));
    if (invalidNeedingFix.length > 10) console.log(dimTxt(`    ...and ${invalidNeedingFix.length - 10} more`));
    console.log('');
    const markBroken = await ask(`  Mark these as BROKEN in ${targetCol} so they stop showing as missing? (y/n)`, 'y');
    if (markBroken.toLowerCase() === 'y') {
      for (const { s1Row } of invalidNeedingFix) s1Row[targetCol] = 'BROKEN';
      fs.writeFileSync(path.join(OUTPUT_DIR, 'Sheet1_updated.csv'), serializeCSV(views.headers, views.rows));
      console.log(ok(`  ✓ Marked ${invalidNeedingFix.length} row(s) as BROKEN and saved.\n`));
    } else {
      console.log('');
    }
  }

  if (!toFetch.length) {
    console.log(ok('  Nothing to fetch — all rows already have data.\n'));
    await pause('Press Enter to exit...');
    process.exit(0);
  }

  const go = await ask(`  Fetch ${bold(toFetch.length)} reels with ${bold(pool.length)} account(s) now? (y/n)`, 'y');
  if (go.toLowerCase() !== 'y') { console.log(warn('\n  Cancelled.\n')); process.exit(0); }

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
  console.log(ok(`\n  ✓ Complete`));
  console.log(`    Fetched   : ${ok(stats.succeeded)}`);
  console.log(`    Deleted   : ${warn(stats.deleted)}`);
  console.log(`    Broken    : ${err(stats.broken)}`);
  console.log(ok(`\n  ✓ Saved to: ${path.join(OUTPUT_DIR, 'Sheet1_updated.csv')}\n`));
  console.log(dimTxt('  Upload back to Google Sheets:'));
  console.log(dimTxt('  File → Import → Upload → Replace current sheet\n'));
  await pause('Press Enter to exit...');
}

main().catch(e => {
  console.error(err(`\n  ✗ Unexpected error: ${e.message}`));
  console.error(dimTxt(e.stack));
  process.exitCode = 1;
});
