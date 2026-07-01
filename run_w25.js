'use strict';

// One-off batch fill for views_w25 against input/missing_instagram_posts.csv.
// Standalone (not requiring tracker.js, since tracker.js auto-runs its interactive main()).

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DIR         = __dirname;
const INPUT_FILE  = path.join(DIR, 'input', 'missing_instagram_posts.csv');
const OUTPUT_FILE = path.join(DIR, 'output', 'missing_instagram_posts_w25.csv');
const COOKIE_FILE = path.join(DIR, 'cookies', 'cookies_1.txt');
const CACHE_FILE  = path.join(DIR, 'cache.json');
const TARGET_COL  = 'views_w25';
const RUN_LABEL   = 'ALL::views_w25';

// ── CSV (copied from tracker.js) ─────────────────────────────────────────────
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
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n');
  const rawHeaders = splitLine(lines[0]).map(h => h.trim());
  // drop unnamed/blank spacer columns entirely
  const keepIdx = rawHeaders.map((h, i) => h ? i : -1).filter(i => i >= 0);
  const headers = keepIdx.map(i => rawHeaders[i]);
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const vals = splitLine(l);
    const obj = {};
    keepIdx.forEach((srcI, j) => obj[headers[j]] = (vals[srcI] ?? '').trim());
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

// ── cookies ───────────────────────────────────────────────────────────────────
function parseCookieFile(text) {
  const obj = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return obj;
}
function cookieStr(c) { return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; '); }

// ── cache ─────────────────────────────────────────────────────────────────────
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { console.error(`cache.json corrupted: ${e.message}`); process.exit(1); }
}
function saveCache() { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); }
function cacheKey(sc) { return `${RUN_LABEL}::${sc}`; }

// ── IG API (copied from tracker.js, with the 400-vs-rate-limit fix) ──────────
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
          resolve({ views: null, authFail: false, gone: status === 400, error: status === 400 ? 'HTTP 400 (deleted or inaccessible)' : 'parse error' });
        }
      });
    });
    req.on('error', e => resolve({ views: null, authFail: false, error: e.message }));
    req.setTimeout(15000, () => { req.destroy(); resolve({ views: null, authFail: false, error: 'timeout' }); });
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cookies = parseCookieFile(fs.readFileSync(COOKIE_FILE, 'utf8'));
  if (!cookies.sessionid || !cookies.csrftoken || !cookies.ds_user_id) {
    console.error('cookies/cookies_1.txt is missing sessionid/csrftoken/ds_user_id'); process.exit(1);
  }

  const csv = parseCSV(fs.readFileSync(INPUT_FILE, 'utf8'));
  if (!csv.headers.includes(TARGET_COL)) csv.headers.push(TARGET_COL);
  csv.rows.forEach(r => { if (r[TARGET_COL] === undefined) r[TARGET_COL] = ''; });

  const queue = [];
  for (const row of csv.rows) {
    if (row.platform !== 'Instagram') continue;
    const val = (row[TARGET_COL] || '').trim();
    if (val && val !== '0') continue; // already has a value
    const sc = stripShortcode(row.post_link);
    if (!sc) continue;
    queue.push({ row, shortcode: sc });
  }

  console.log(`Total rows: ${csv.rows.length}  |  To fetch: ${queue.length}`);

  let succeeded = 0, deleted = 0, broken = 0, authFailStreak = 0;
  const total = queue.length;

  for (let i = 0; i < queue.length; i++) {
    const { row, shortcode } = queue[i];
    const idx = i + 1;
    const key = cacheKey(shortcode);

    if (cache[key] !== undefined) {
      row[TARGET_COL] = String(cache[key]);
      succeeded++;
      console.log(`[${idx}/${total}] ${shortcode.padEnd(14)} -> ${cache[key]} (cached)`);
      continue;
    }

    const result = await fetchViews(shortcode, cookies);

    if (result.rateLimited) {
      console.log(`[${idx}/${total}] ${shortcode.padEnd(14)} -> PAUSED (${result.error}), backing off 15s`);
      i--; // retry same item
      await sleep(15000);
      continue;
    }

    if (result.authFail) {
      authFailStreak++;
      console.log(`[${idx}/${total}] ${shortcode.padEnd(14)} -> AUTH FAILED (streak ${authFailStreak}): ${result.error}`);
      if (authFailStreak >= 3) {
        console.error('\nToo many consecutive auth failures — cookies are likely invalid/expired. Stopping.');
        break;
      }
      i--; // retry same item
      await sleep(1500);
      continue;
    }
    authFailStreak = 0;

    if (result.views !== null) {
      row[TARGET_COL] = String(result.views);
      cache[key] = String(result.views);
      succeeded++;
      console.log(`[${idx}/${total}] ${shortcode.padEnd(14)} -> ${result.views.toLocaleString()} views`);
    } else {
      const label = result.gone ? 'DELETED' : 'BROKEN';
      row[TARGET_COL] = label;
      cache[key] = label;
      label === 'DELETED' ? deleted++ : broken++;
      console.log(`[${idx}/${total}] ${shortcode.padEnd(14)} -> ${label} (${result.error})`);
    }

    if (idx % 10 === 0 || idx === total) {
      fs.writeFileSync(OUTPUT_FILE, serializeCSV(csv.headers, csv.rows));
      saveCache();
    }

    await sleep(900 + Math.random() * 600);
  }

  fs.writeFileSync(OUTPUT_FILE, serializeCSV(csv.headers, csv.rows));
  saveCache();

  console.log(`\nDone. Succeeded: ${succeeded}  Deleted: ${deleted}  Broken: ${broken}`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch(e => { console.error('Unexpected error:', e.stack); process.exitCode = 1; });
