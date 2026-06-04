#!/usr/bin/env node
'use strict';

const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ── paths ───────────────────────────────────────────────────────────────────
const DIR          = __dirname;
const INPUT_DIR    = path.join(DIR, 'input');
const COOKIES_FILE = path.join(DIR, 'cookies.txt');
const CACHE_FILE   = path.join(DIR, 'cache.db');
const REPORTS_DIR  = path.join(DIR, 'reports');

// ── SQLite (Node 22+ native; JSON fallback for older Node) ──────────────────
let db;
let useNativeSQLite = false;

function initDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(CACHE_FILE);
    useNativeSQLite = true;
  } catch (_) {
    db = new JsonDb(CACHE_FILE + '.json');
  }
  dbRun(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL, shortcode TEXT NOT NULL,
    username TEXT, url TEXT, views INTEGER, fetched_at TEXT,
    UNIQUE(run_id, shortcode)
  )`);
  dbRun(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL
  )`);
}

function dbRun(sql, params = []) {
  if (useNativeSQLite) return db.prepare(sql).run(...params);
  return db.run(sql, params);
}
function dbAll(sql, params = []) {
  if (useNativeSQLite) return db.prepare(sql).all(...params);
  return db.all(sql, params);
}
function dbGet(sql, params = []) {
  if (useNativeSQLite) return db.prepare(sql).get(...params);
  return db.get(sql, params);
}

// ── JSON fallback DB ─────────────────────────────────────────────────────────
class JsonDb {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { tables: {} };
  }
  _save() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  run(sql, params) {
    const ins = sql.match(/INSERT OR IGNORE INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    const cr  = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
    if (cr) { if (!this.data.tables[cr[1]]) this.data.tables[cr[1]] = []; this._save(); return; }
    if (ins) {
      const tbl = ins[1], cols = ins[2].split(',').map(s => s.trim()), row = {};
      cols.forEach((c, i) => row[c] = params[i]);
      if (!this.data.tables[tbl]) this.data.tables[tbl] = [];
      const key = Object.keys(row).slice(0, 2).map(k => row[k]).join('|');
      const exists = this.data.tables[tbl].some(r => Object.keys(row).slice(0, 2).map(k => r[k]).join('|') === key);
      if (!exists) { this.data.tables[tbl].push(row); this._save(); }
    }
  }
  all(sql, params) {
    const sel = sql.match(/FROM (\w+)(.*)/is);
    if (!sel) return [];
    let rows = [...(this.data.tables[sel[1]] || [])];
    if (params.length) {
      const wheres = (sel[2].match(/(\w+)\s*=\s*\?/g) || []).map(w => w.split(/\s*=\s*/)[0].trim());
      rows = rows.filter(r => wheres.every((col, i) => String(r[col]) === String(params[i])));
    }
    return rows;
  }
  get(sql, params) { return this.all(sql, params)[0] || null; }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
const now   = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stripShortcode(url) {
  const m = (url || '').match(/instagram\.com\/reel\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function shortcodeToMediaId(sc) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(0);
  for (const c of sc) n = n * BigInt(64) + BigInt(alpha.indexOf(c));
  return n.toString();
}

// ── terminal UI ──────────────────────────────────────────────────────────────
const W = 62;
const line  = (c = '─') => c.repeat(W);
const blank = ()         => console.log('');

function header(title) {
  console.clear();
  console.log(line('━'));
  console.log('  IG Reels View Tracker');
  console.log(line('━'));
  if (title) { blank(); console.log(`  ${title}`); console.log(line()); }
  blank();
}

function status() {
  const hasCookies = fs.existsSync(COOKIES_FILE);
  const inputFiles = fs.existsSync(INPUT_DIR)
    ? fs.readdirSync(INPUT_DIR).filter(f => f.toLowerCase().endsWith('.csv'))
    : [];
  const reports = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.csv')).sort().reverse()
    : [];
  const sessions = dbAll(`SELECT run_id, started_at FROM sessions ORDER BY started_at DESC`);

  console.log(`  Cookies   : ${hasCookies ? '✓ loaded' : '✗ not set'}`);
  console.log(`  Input dir : ${inputFiles.length} CSV(s) in input/`);
  console.log(`  Last run  : ${sessions[0] ? sessions[0].started_at.slice(0, 16) : 'never'}`);
  console.log(`  Reports   : ${reports.length} saved`);
  blank();
}

// Prompt a single line
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(`  ${q}`, ans => { rl.close(); resolve(ans.trim()); }));
}

// Collect multiline paste (blank line = done)
async function collectPaste(instructions) {
  console.log(`  ${instructions}`);
  console.log(`  Press Enter on a blank line when done.`);
  blank();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = [];
  return new Promise(resolve => {
    rl.on('line', line => {
      if (line === '' && lines.length && lines[lines.length - 1] === '') {
        rl.close();
      } else {
        lines.push(line);
      }
    });
    rl.on('close', () => resolve(lines.join('\n')));
  });
}

// Main menu choice
async function menuChoice(options) {
  const keys = options.map(o => o.key);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  > ', ans => {
      rl.close();
      const choice = ans.trim().toLowerCase();
      if (keys.includes(choice)) resolve(choice);
      else resolve(null);
    });
  });
}

function pause() {
  return prompt('Press Enter to return to menu...');
}

// ── cookies ──────────────────────────────────────────────────────────────────
let cookies = {};

function loadCookies() {
  if (!fs.existsSync(COOKIES_FILE)) return false;
  cookies = {};
  for (const line of fs.readFileSync(COOKIES_FILE, 'utf8').split('\n')) {
    const [k, ...v] = line.split('=');
    if (k && v.length) cookies[k.trim()] = v.join('=').trim();
  }
  return !!(cookies.sessionid && cookies.csrftoken && cookies.ds_user_id);
}

function saveCookies() {
  fs.writeFileSync(COOKIES_FILE, Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('\n'));
}

function cookieHeader() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function menuUpdateCookies(reason = '') {
  header('Update Cookies');
  if (reason) { console.log(`  ⚠  ${reason}`); blank(); }
  console.log('  Open Instagram in Chrome → F12 → Application → Cookies');
  console.log('  Copy the values for sessionid, csrftoken, ds_user_id');
  blank();
  cookies.sessionid  = await prompt('sessionid  = ');
  cookies.csrftoken  = await prompt('csrftoken  = ');
  cookies.ds_user_id = await prompt('ds_user_id = ');
  saveCookies();
  blank();
  console.log('  ✓ Cookies saved.');
  blank();
  await pause();
}

// ── IG API ───────────────────────────────────────────────────────────────────
function fetchMediaInfo(shortcode) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'i.instagram.com',
      path: `/api/v1/media/${shortcodeToMediaId(shortcode)}/info/`,
      method: 'GET',
      headers: {
        'User-Agent' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        'X-CSRFToken': cookies.csrftoken,
        'Referer'    : 'https://www.instagram.com/',
        'X-IG-App-ID': '936619743392459',
        'Cookie'     : cookieHeader(),
      },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// ── CSV ──────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  return lines.slice(1).map(line => {
    const vals = splitCSVLine(line), obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim());
    return obj;
  });
}

function splitCSVLine(line) {
  const result = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function toCSV(rows, headers) {
  const esc = v => (String(v).includes(',') || String(v).includes('"'))
    ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h] ?? '')).join(','))].join('\n');
}

function reelsFromCSVText(text, source) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const urlCol  = Object.keys(rows[0]).find(k => k.includes('url'));
  const userCol = Object.keys(rows[0]).find(k => k.includes('user') || k.includes('submitter'));
  if (!urlCol) { console.log(`  ⚠  No "url" column in ${source} — skipped`); return []; }
  return rows
    .map(r => ({ url: r[urlCol], username: userCol ? (r[userCol] || '') : '' }))
    .map(r => ({ ...r, shortcode: stripShortcode(r.url) }))
    .filter(r => r.shortcode);
}

function extractUrlsFromBlob(text) {
  const matches = text.match(/https?:\/\/(?:www\.)?instagram\.com\/reel\/[A-Za-z0-9_\-/?=&%]+/g) || [];
  return [...new Set(matches)];
}

function dedupeReels(reels) {
  const seen = new Set();
  return reels.filter(r => { if (seen.has(r.shortcode)) return false; seen.add(r.shortcode); return true; });
}

// ── input menu ───────────────────────────────────────────────────────────────
async function menuSelectInput() {
  while (true) {
    header('Select Input');

    const inputFiles = fs.existsSync(INPUT_DIR)
      ? fs.readdirSync(INPUT_DIR).filter(f => f.toLowerCase().endsWith('.csv'))
      : [];

    console.log(`  [1] Use input/ folder   (${inputFiles.length} CSV(s) found)`);
    console.log(`  [2] Drag & drop a CSV   (enter file path)`);
    console.log(`  [3] Paste URLs or CSV text`);
    console.log(`  [B] Back`);
    blank();

    const choice = await menuChoice([
      { key: '1' }, { key: '2' }, { key: '3' }, { key: 'b' }
    ]);

    if (choice === 'b') return null;

    if (choice === '1') {
      if (!inputFiles.length) {
        blank();
        console.log('  ✗ No CSV files in input/ folder. Drop some files there and try again.');
        blank();
        await pause();
        continue;
      }
      let all = [];
      console.log(`  Loading ${inputFiles.length} file(s)...`);
      for (const f of inputFiles) {
        const reels = reelsFromCSVText(fs.readFileSync(path.join(INPUT_DIR, f), 'utf8'), f);
        console.log(`  • ${f} → ${reels.length} reel(s)`);
        all = all.concat(reels);
      }
      return dedupeReels(all);
    }

    if (choice === '2') {
      blank();
      const filePath = await prompt('File path (or drag file here): ');
      const clean = filePath.replace(/^["']|["']$/g, '').trim();
      if (!fs.existsSync(clean)) {
        console.log('  ✗ File not found.');
        await pause();
        continue;
      }
      const reels = reelsFromCSVText(fs.readFileSync(clean, 'utf8'), path.basename(clean));
      if (!reels.length) {
        console.log('  ✗ No valid reels found in that file.');
        await pause();
        continue;
      }
      return dedupeReels(reels);
    }

    if (choice === '3') {
      blank();
      const blob = await collectPaste('Paste anything — URLs, CSV, mixed text. It will extract all IG reel links.');
      const urls = extractUrlsFromBlob(blob);
      if (!urls.length) {
        console.log('  ✗ No Instagram reel URLs found.');
        await pause();
        continue;
      }
      // Try structured CSV parse first
      let reels = blob.toLowerCase().includes('url') ? reelsFromCSVText(blob, 'pasted') : [];
      if (!reels.length) {
        reels = urls.map(url => ({ url, username: '', shortcode: stripShortcode(url) })).filter(r => r.shortcode);
      }
      return dedupeReels(reels);
    }
  }
}

// ── run tracker ──────────────────────────────────────────────────────────────
async function menuRunTracker() {
  if (!loadCookies()) {
    await menuUpdateCookies('No cookies found. Set them up first.');
    if (!loadCookies()) return;
  }

  const reels = await menuSelectInput();
  if (!reels || !reels.length) return;

  header('Running Tracker');
  console.log(`  ${reels.length} reel(s) to fetch`);
  blank();

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

  const runId = `run_${Date.now()}`;
  dbRun(`INSERT OR IGNORE INTO sessions (run_id, started_at) VALUES (?, ?)`, [runId, now()]);

  const allSessions = dbAll(`SELECT run_id, started_at FROM sessions ORDER BY started_at DESC`);
  const prevRunId   = allSessions.length > 1 ? allSessions[1].run_id : null;

  if (prevRunId) console.log(`  Comparing against: ${allSessions[1].started_at.slice(0, 16)}`);
  else           console.log(`  First run — no delta yet`);
  blank();
  console.log(line());
  blank();

  const results = [];
  let cookieFailStreak = 0;

  for (let i = 0; i < reels.length; i++) {
    const { shortcode, url, username } = reels[i];
    const label = `[${String(i+1).padStart(String(reels.length).length)}/${reels.length}]`;

    const cached = dbGet(`SELECT views FROM runs WHERE run_id = ? AND shortcode = ?`, [runId, shortcode]);
    if (cached) {
      console.log(`  ${label} ${shortcode}  →  ${cached.views.toLocaleString()} (cached)`);
      results.push({ shortcode, url, username, views: cached.views, error: null });
      continue;
    }

    process.stdout.write(`  ${label} ${shortcode}  →  `);

    let views = null, error = null, attempts = 0;

    while (attempts < 3) {
      try {
        const { status, data } = await fetchMediaInfo(shortcode);

        if (status === 401 || status === 403 || data?.message === 'login_required') {
          cookieFailStreak++;
          if (cookieFailStreak >= 2) {
            process.stdout.write('\n');
            await menuUpdateCookies('Instagram auth error — cookies may have expired.');
            loadCookies();
            cookieFailStreak = 0;
          }
          attempts++;
          continue;
        }

        if (data?.items?.[0]) {
          const item = data.items[0];
          views = item.play_count ?? item.view_count ?? 0;
          cookieFailStreak = 0;
          break;
        } else {
          error = data?.message || `HTTP ${status}`;
          break;
        }
      } catch (e) {
        error = e.message;
        break;
      }
    }

    if (views !== null) {
      console.log(`${views.toLocaleString()} views`);
      dbRun(
        `INSERT OR IGNORE INTO runs (run_id, shortcode, username, url, views, fetched_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, shortcode, username || '', url, views, now()]
      );
    } else {
      console.log(`ERROR — ${error}`);
    }

    results.push({ shortcode, url, username, views, error });
    if (i < reels.length - 1) await sleep(2000 + Math.random() * 1000);
  }

  // Build report
  blank();
  console.log(line());
  blank();
  console.log('  Building report...');

  const reportRows = results.map(r => {
    let prevViews = null, delta = '', deltaPct = '';
    if (prevRunId && r.views !== null) {
      const prev = dbGet(`SELECT views FROM runs WHERE run_id = ? AND shortcode = ?`, [prevRunId, r.shortcode]);
      if (prev) {
        prevViews = prev.views;
        const d = r.views - prevViews;
        delta    = (d >= 0 ? '+' : '') + d.toLocaleString();
        deltaPct = prevViews > 0 ? (d >= 0 ? '+' : '') + ((d / prevViews) * 100).toFixed(1) + '%' : 'N/A';
      }
    }
    return {
      username: r.username || '', url: r.url, shortcode: r.shortcode,
      views: r.views ?? '', prev_views: prevViews ?? '',
      delta, delta_pct: deltaPct, error: r.error || '',
    };
  });

  reportRows.sort((a, b) => {
    if (a.username < b.username) return -1;
    if (a.username > b.username) return 1;
    return (Number(b.views) || 0) - (Number(a.views) || 0);
  });

  const filename = path.join(REPORTS_DIR, `report_${today()}.csv`);
  fs.writeFileSync(filename, toCSV(reportRows, ['username','url','shortcode','views','prev_views','delta','delta_pct','error']));

  blank();
  console.log(`  ✓ Report saved: reports/report_${today()}.csv`);
  blank();
  console.log(line());
  blank();

  // Summary by user
  const byUser = {};
  for (const r of reportRows) {
    const u = r.username || '(no username)';
    if (!byUser[u]) byUser[u] = [];
    byUser[u].push(r);
  }
  for (const [user, rows] of Object.entries(byUser)) {
    const total = rows.reduce((s, r) => s + (Number(r.views) || 0), 0);
    const err   = rows.filter(r => r.error).length;
    const errStr = err ? `  ⚠ ${err} error(s)` : '';
    console.log(`  ${user.padEnd(20)} ${rows.length} reel(s)   ${total.toLocaleString()} views${errStr}`);
  }

  blank();
  await pause();
}

// ── view reports ─────────────────────────────────────────────────────────────
async function menuViewReports() {
  header('Reports');

  const reports = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.csv')).sort().reverse()
    : [];

  if (!reports.length) {
    console.log('  No reports yet.');
    blank();
    await pause();
    return;
  }

  reports.forEach((f, i) => console.log(`  [${i+1}] ${f}`));
  console.log(`  [B] Back`);
  blank();

  const ans = await prompt('Open report # (or B): ');
  if (ans.toLowerCase() === 'b') return;

  const idx = parseInt(ans) - 1;
  if (isNaN(idx) || !reports[idx]) return;

  const filePath = path.join(REPORTS_DIR, reports[idx]);
  blank();
  console.log(`  ${reports[idx]}`);
  console.log(line());
  blank();

  const rows = parseCSV(fs.readFileSync(filePath, 'utf8'));
  if (!rows.length) { console.log('  (empty)'); blank(); await pause(); return; }

  // Print table
  const cols = ['username', 'shortcode', 'views', 'delta', 'delta_pct', 'error'];
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] || '').length)));
  const row2str = r => cols.map((c, i) => String(r[c] || '').padEnd(widths[i])).join('  ');
  console.log('  ' + cols.map((c, i) => c.toUpperCase().padEnd(widths[i])).join('  '));
  console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));
  for (const r of rows) console.log('  ' + row2str(r));

  blank();
  await pause();
}

// ── main menu ────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(INPUT_DIR)) fs.mkdirSync(INPUT_DIR);
  initDb();

  while (true) {
    header(null);
    status();
    console.log(`  [1] Run tracker`);
    console.log(`  [2] View reports`);
    console.log(`  [3] Update cookies`);
    console.log(`  [Q] Quit`);
    blank();

    const choice = await menuChoice([{ key: '1' }, { key: '2' }, { key: '3' }, { key: 'q' }]);

    if (choice === '1') await menuRunTracker();
    if (choice === '2') await menuViewReports();
    if (choice === '3') { loadCookies(); await menuUpdateCookies(); }
    if (choice === 'q') { console.clear(); process.exit(0); }
  }
}

main().catch(e => { console.error('\n✗ Fatal error:', e.message); process.exit(1); });
