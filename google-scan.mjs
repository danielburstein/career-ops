#!/usr/bin/env node
/**
 * google-scan.mjs — Google Search–based job scanner for early-career SWE roles
 *
 * Stage 1: runs several title-variant Google queries over Lever and Greenhouse
 * job boards, fetches each posting's description (with location),
 * and saves new jobs to data/jobs.db with status 'not_checked'.
 *
 * Usage:
 *   node google-scan.mjs [--dry-run] [--headless] [--pages 3] [--day | --week | --month | --all]
 *     default: past 24 hours — each daily run surfaces newly indexed postings
 *     --week   past week — use to catch up after skipping a few days
 *     --month  past month    --all  no date restriction
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import pLimit from 'p-limit';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  db: join(ROOT, 'data', 'jobs.db'),
};

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

// Discovery-oriented search: each variant runs as its own Google query; results are
// merged + deduped. Freshness defaults to past 24 hours so every daily run surfaces a
// fresh rotating set of newly indexed postings (small companies included) instead of
// Google's static all-time top results.
//
// Three tactics working together:
//   1. Negative filters (-senior -lead ...) make Google drop obvious senior/staff
//      postings before they ever reach stage 2's LLM — saves the token budget.
//   2. Micro-slicing: a matrix of stack × title × location queries. Each narrow slice
//      forces Google to surface its "long tail" instead of the same top results —
//      grow STACKS/TITLES to widen coverage.
//   3. inurl: slices catch postings whose seniority is baked into the URL slug
//      (Greenhouse/Lever slugs like /junior-software-engineer or /new-grad-2025).
//
// CONSTRAINT: Google silently ignores query terms past ~32 words (each word inside a
// quoted phrase counts). Every group below is deliberately trimmed so the full
// boards + slice + location + seniority + negatives stack stays ≤32 — the negatives
// sit at the end of the query, so they're the first thing lost if we blow the budget.
// countQueryTerms() warns at startup if a variant goes over.
const JOB_SITES = '(site:jobs.lever.co OR site:boards.greenhouse.io OR site:job-boards.greenhouse.io OR site:jobs.ashbyhq.com)';
const SENIORITY = '("new grad" OR junior OR "entry level" OR 2025)';
const LOCATIONS = '("San Francisco" OR "Bay Area" OR remote)';
// -sr/-principal/-director omitted to fit the 32-term budget; the SENIORITY anchor
// keeps those pages rare and stage 2 catches the stragglers.
const NEGATIVES = '-senior -lead -staff -manager -"5+ years"';

// Slice 1: tech stacks — each term makes Google index-match different pages
const STACKS = ['python', 'backend', 'full stack', 'AI', 'infrastructure', 'API', 'systems'];
// Slice 2: exact <title> matches on the job board page itself
const TITLES = ['"software engineer"', '"backend engineer"', '"developer"'];

const SEARCH_VARIANTS = [];

for (const stack of STACKS) {
  SEARCH_VARIANTS.push({
    label: `${stack} engineer (SF/remote)`,
    q: `${JOB_SITES} "${stack}" engineer ${LOCATIONS} ${SENIORITY} ${NEGATIVES}`,
  });
}

for (const title of TITLES) {
  SEARCH_VARIANTS.push({
    label: `intitle:${title}`,
    q: `${JOB_SITES} intitle:${title} ${LOCATIONS} ${SENIORITY} ${NEGATIVES}`,
  });
}

// Slice 3: seniority baked into the URL slug. Parentheses matter: Google's OR binds
// tightly, so an unparenthesized `inurl:a OR inurl:b` would split the query in half.
SEARCH_VARIANTS.push(
  { label: 'inurl: new-grad / 2025 / university', q: `${JOB_SITES} (inurl:new-grad OR inurl:2025 OR inurl:university) ${NEGATIVES}` },
  { label: 'inurl: junior / entry / associate', q: `${JOB_SITES} (inurl:junior OR inurl:entry OR inurl:associate) ${NEGATIVES}` },
  // Broad catch-all: no seniority anchor on purpose — the 24h window keeps volume
  // sane and stage 2's LLM does the real experience filtering.
  { label: 'software engineer (broad — stage 2 filters)', q: `${JOB_SITES} "software engineer" ${LOCATIONS} ${NEGATIVES}` },
);

// Rough proxy for Google's 32-term cap: whitespace-split words (quoted phrases count
// per word, which matches how Google counts them).
function countQueryTerms(q) {
  return q.split(/\s+/).filter(Boolean).length;
}
for (const v of SEARCH_VARIANTS) {
  const n = countQueryTerms(v.q);
  if (n > 32) {
    console.warn(`⚠️  Query "${v.label}" has ${n} terms — Google ignores everything past 32, starting with the negative filters.`);
  }
}

const CHROME_EXE = os.platform() === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : os.platform() === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
const DEBUG_PORT = 9223;

// ============================================================================
// Database initialization
// ============================================================================
function initDatabase() {
  const db = new Database(PATHS.db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT UNIQUE NOT NULL,
      company       TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT,
      source        TEXT,
      status        TEXT NOT NULL DEFAULT 'not_checked',
      experience_years REAL,
      location      TEXT,
      first_seen    TEXT NOT NULL,
      processed_at  TEXT,
      applied_at    TEXT,
      skip_reason   TEXT
    )
  `);
  createViews(db);
  return db;
}

// Category views — show up as virtual "folders" in DBeaver, always in sync with the jobs table.
// Dropped and recreated on every run so definition changes here take effect automatically.
function createViews(db) {
  db.exec(`
    DROP VIEW IF EXISTS processing;
    CREATE VIEW processing AS
      SELECT id, company, title, source, url, first_seen
      FROM jobs WHERE status = 'not_checked' ORDER BY id;

    DROP VIEW IF EXISTS to_apply;
    CREATE VIEW to_apply AS
      SELECT id, company, title, location, experience_years, url, first_seen
      FROM jobs WHERE status = 'verified' ORDER BY id;

    DROP VIEW IF EXISTS applied;
    CREATE VIEW applied AS
      SELECT id, company, title, location, url, applied_at
      FROM jobs WHERE status = 'applied' ORDER BY applied_at DESC, id DESC;

    DROP VIEW IF EXISTS stale;
    CREATE VIEW stale AS
      SELECT id, company, title, location, url, first_seen, processed_at
      FROM jobs WHERE skip_reason = 'posting_closed' ORDER BY id;

    DROP VIEW IF EXISTS skipped;
    CREATE VIEW skipped AS
      SELECT id, company, title, location, experience_years, skip_reason, url
      FROM jobs WHERE status = 'skipped' AND skip_reason != 'posting_closed'
      ORDER BY skip_reason, id;

    DROP VIEW IF EXISTS pipeline_summary;
    CREATE VIEW pipeline_summary AS
      SELECT status, COALESCE(skip_reason, '-') AS reason, COUNT(*) AS count
      FROM jobs GROUP BY status, skip_reason ORDER BY count DESC;
  `);
}

function getSeenUrls(db) {
  const rows = db.prepare('SELECT url FROM jobs').all();
  return new Set(rows.map(r => r.url));
}

// ============================================================================
// Parse CLI args
// ============================================================================
const args = process.argv.slice(2);
let dryRun = false;
let headless = false;
let maxPages = 4;

let freshness = 'd'; // Google tbs=qdr: filter — default: past 24 hours, so daily runs surface new postings

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  if (args[i] === '--headless') headless = true;
  if (args[i] === '--pages' && args[i + 1]) maxPages = parseInt(args[++i], 10);
  if (args[i] === '--day') freshness = 'd';      // past 24 hours (default)
  if (args[i] === '--week') freshness = 'w';     // past week — catch-up after skipping days
  if (args[i] === '--month') freshness = 'm';    // past month
  if (args[i] === '--all') freshness = null;     // no date restriction
}

// ============================================================================
// Validate environment
// ============================================================================
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey && !dryRun) {
  console.error(`
❌ GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ============================================================================
// Load dedup data
// ============================================================================
function loadSeenUrls() {
  const seenUrls = new Set();

  // From scan-history.tsv
  if (existsSync(PATHS.scanHistory)) {
    const content = readFileSync(PATHS.scanHistory, 'utf-8');
    const lines = content.split('\n').slice(1); // skip header
    lines.forEach(line => {
      if (!line.trim()) return;
      const cols = line.split('\t');
      if (cols[0]) seenUrls.add(cols[0]);
    });
  }

  // From pipeline.md
  if (existsSync(PATHS.pipeline)) {
    const content = readFileSync(PATHS.pipeline, 'utf-8');
    const matches = content.match(/https?:\/\/[^\s|}\]]+/g) || [];
    matches.forEach(url => seenUrls.add(url));
  }

  // From applications.md
  if (existsSync(PATHS.applications)) {
    const content = readFileSync(PATHS.applications, 'utf-8');
    const matches = content.match(/https?:\/\/[^\s|}\]]+/g) || [];
    matches.forEach(url => seenUrls.add(url));
  }

  return seenUrls;
}

// ============================================================================
// Extract company slug from URL
// ============================================================================
function extractCompanySlug(url) {
  const match = url.match(/(?:jobs\.lever\.co|(?:boards|job-boards)\.greenhouse\.io|jobs\.ashbyhq\.com)\/([^\/]+)/);
  return match ? match[1] : 'unknown';
}

// ============================================================================
// Validate job URL format
// ============================================================================
function isValidJobUrl(url) {
  const leverPattern = /jobs\.lever\.co\/[^\/]+\/[^\/]+/;
  const greenhousePattern = /(?:boards|job-boards)\.greenhouse\.io\/[^\/]+\/jobs\/[^\/]+/;
  const ashbyPattern = /jobs\.ashbyhq\.com\/[^\/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  return leverPattern.test(url) || greenhousePattern.test(url) || ashbyPattern.test(url);
}

// Strip Google text fragments (#:~:text=...), query params, and trailing /apply
// so the same job always maps to one canonical URL (DB dedup relies on this)
function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    let pathname = u.pathname.replace(/\/(?:apply|application)\/?$/, ''); // Lever /apply, Ashby /application
    if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${u.origin}${pathname}`;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
}

// ============================================================================
// Get ChromeForAutomation directory (cross-platform)
// ============================================================================
function getAutomationDataDir() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Google', 'ChromeForAutomation');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'ChromeForAutomation');
    default:
      return path.join(home, '.config', 'google-chrome-automation');
  }
}

// ============================================================================
// Detect CAPTCHA or consent pages
// ============================================================================
async function isCaptchaOrConsentPage(page) {
  try {
    const url = page.url();
    if (url.includes('consent.google.com') || url.includes('/sorry/')) return true;

    const text = await page.textContent('body').catch(() => '');
    return /unusual traffic|not a robot|before you continue|I agree/i.test(text || '');
  } catch {
    return false;
  }
}

// ============================================================================
// Wait for user to solve CAPTCHA
// ============================================================================
async function waitForCaptcha(page) {
  console.log('\n⚠️  Google CAPTCHA detected.');
  console.log('   Solve it in the browser window, then press Enter to continue...\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });

  console.log('▶  Resuming scan...\n');
}

// ============================================================================
// Kill Chrome if running
// ============================================================================
function killChrome() {
  try {
    if (os.platform() === 'win32') {
      execSync('taskkill /IM chrome.exe /F 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill -9 chrome', { stdio: 'ignore' });
    }
  } catch {
    // Not running
  }
}

// ============================================================================
// Launch Chrome with debugging port via spawn
// ============================================================================
async function launchChrome(userDataDir) {
  console.log('🚀 Launching Chrome with real profile...');

  spawn(CHROME_EXE, [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate',
  ], { detached: true, stdio: 'ignore' }).unref();

  // Poll until Chrome DevTools is ready
  console.log('  Waiting for Chrome to be ready...');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
      if (res.ok) {
        console.log('  ✅ Chrome ready\n');
        return;
      }
    } catch {
      // Not ready
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Chrome did not start within 20s');
}

// ============================================================================
// Connect to Chrome via CDP
// ============================================================================
async function connectChrome() {
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}

// ============================================================================
// Scrape Google Search with Playwright
// ============================================================================
async function scrapeGoogleSearch() {
  console.log(`🔍 Preparing to search Google...`);

  const automationDataDir = getAutomationDataDir();
  const useRealChrome = existsSync(automationDataDir);

  let browser;
  let page;

  try {
    if (useRealChrome) {
      console.log(`📌 Using real Chrome profile (has Google session, no CAPTCHA expected)\n`);
      killChrome(); // Kill any existing instance
      await launchChrome(automationDataDir);
      const conn = await connectChrome();
      browser = conn.browser;
      page = conn.page;
    } else {
      console.log(`📌 Using Playwright Chromium (may see CAPTCHA)\n`);
      browser = await chromium.launch({ headless });
      page = await browser.newPage();
    }

    page.setDefaultTimeout(30000);

    const urls = new Set();
    const freshnessLabel = freshness === 'd' ? 'past 24 hours' : freshness === 'w' ? 'past week' : freshness === 'm' ? 'past month' : 'all time';
    console.log(`📍 Running ${SEARCH_VARIANTS.length} query variants × up to ${maxPages} pages each (${freshnessLabel})\n`);

    for (let qIdx = 0; qIdx < SEARCH_VARIANTS.length; qIdx++) {
      // filter=0 disables Google's near-duplicate omission — job board pages are
      // template-heavy, so without it Google hides most of them as "very similar"
      const searchUrl = `${GOOGLE_SEARCH_URL}?q=${encodeURIComponent(SEARCH_VARIANTS[qIdx].q)}`
        + '&filter=0'
        + (freshness ? `&tbs=qdr:${freshness}` : '');
      console.log(`  🔎 [${qIdx + 1}/${SEARCH_VARIANTS.length}] ${SEARCH_VARIANTS[qIdx].label}`);

      for (let pageNum = 0; pageNum < maxPages; pageNum++) {
        const pageUrl = pageNum === 0 ? searchUrl : `${searchUrl}&start=${pageNum * 10}`;

        try {
          await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45000 });
        } catch (err) {
          // Timeout on the very first load is fatal; anywhere else, move on
          if (qIdx === 0 && pageNum === 0) throw err;
          console.log(`     (page ${pageNum + 1} timed out, moving on)`);
          break;
        }

        // Check for CAPTCHA and wait if needed
        while (await isCaptchaOrConsentPage(page)) {
          await waitForCaptcha(page);
          await page.reload({ waitUntil: 'networkidle' });
        }

        await page.waitForTimeout(1000 + Math.random() * 1500); // random delay between requests

        // Extract all job board links
        const links = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          return anchors
            .map(a => a.href)
            .filter(href =>
              href.includes('lever.co') || href.includes('greenhouse.io') || href.includes('ashbyhq.com')
            );
        });

        // Zero job-board links = "did not match any documents" (normal for a thin
        // 24h window) — skip the remaining pages of this query
        if (links.length === 0) {
          if (pageNum === 0) console.log('     (no results in this window)');
          break;
        }

        const before = urls.size;
        links.forEach(url => {
          // Clean up Google redirect wrapper
          let cleanUrl = url;
          if (url.includes('url?q=')) {
            const match = url.match(/url\?q=([^&]+)/);
            if (match) cleanUrl = decodeURIComponent(match[1]);
          }
          cleanUrl = normalizeJobUrl(cleanUrl);
          if (isValidJobUrl(cleanUrl)) {
            urls.add(cleanUrl);
          }
        });

        // Nothing new past page 1 usually means end of results for this query
        if (pageNum > 0 && urls.size === before) break;
      }

      console.log(`     running total: ${urls.size} unique URLs`);
    }

    if (useRealChrome) {
      killChrome(); // Cleanup
    } else {
      await browser.close();
    }

    return Array.from(urls);
  } catch (err) {
    if (page) await page.close().catch(() => {});
    if (browser && !useRealChrome) await browser.close().catch(() => {});
    if (useRealChrome) killChrome();
    throw err;
  }
}

// ============================================================================
// Strip HTML tags from text
// ============================================================================
function stripHtml(html) {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n\n+/g, '\n')
    .trim();
}

// ============================================================================
// Fetch job description HTML (fallback)
// ============================================================================
async function fetchJDHtml(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': CHROME_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return `[Could not fetch: HTTP ${response.status}]`;
    }

    let text = stripHtml(await response.text());
    if (text.length > 5000) {
      text = text.substring(0, 5000) + '\n[... truncated ...]';
    }
    return text || '[Empty JD]';
  } catch (err) {
    return `[Fetch error: ${err.message}]`;
  }
}

// ============================================================================
// Fetch job description via API (Lever + Greenhouse) with HTML fallback
// ============================================================================
async function fetchJD(url) {
  // Lever API: https://api.lever.co/v0/postings/{company}/{jobSlug}?mode=json
  const leverMatch = url.match(/jobs\.lever\.co\/([^\/?\s]+)\/([^\/?\s]+)/);
  if (leverMatch) {
    const [, company, jobSlug] = leverMatch;
    try {
      const res = await fetch(`https://api.lever.co/v0/postings/${company}/${jobSlug}?mode=json`, {
        headers: { 'User-Agent': CHROME_USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        // Check if response is an error
        if (data.ok === false) {
          // Job not found via API, fall through
        } else {
          // Location lives in metadata, not the description text — prepend it so the LLM can see it
          const locationParts = [data.categories?.location, data.workplaceType].filter(p => p && p !== 'unspecified');
          const header = locationParts.length ? `Location: ${locationParts.join(' | ')}\n\n` : '';
          const sections = [
            data.text || '',
            data.descriptionPlain || stripHtml(data.description || ''),
            ...(data.lists || []).map(l => `${l.text}\n${stripHtml(l.content)}`),
            data.additionalPlain || stripHtml(data.additional || ''),
          ];
          const text = sections.filter(Boolean).join('\n').trim();
          if (text.length > 50) {
            return { title: data.text || null, description: (header + text).substring(0, 5000) };
          }
        }
      }
    } catch {
      // Fall through to HTML scrape
    }
  }

  // Greenhouse API: https://boards-api.greenhouse.io/v1/boards/{company}/jobs/{jobId}
  const ghMatch = url.match(/(?:boards|job-boards)\.greenhouse\.io\/([^\/?\s]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const [, company, jobId] = ghMatch;
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`, {
        headers: { 'User-Agent': CHROME_USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        const header = data.location?.name ? `Location: ${data.location.name}\n\n` : '';
        const text = stripHtml(data.content || '');
        if (text.length > 50) {
          return { title: data.title || null, description: (header + text).substring(0, 5000) };
        }
      }
    } catch {
      // Fall through
    }
  }

  // Ashby posting API: https://api.ashbyhq.com/posting-api/job-board/{org} returns the whole board
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^\/?#\s]+)\/([0-9a-f-]{36})/i);
  if (ashbyMatch) {
    const [, org, jobId] = ashbyMatch;
    try {
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${org}`, {
        headers: { 'User-Agent': CHROME_USER_AGENT, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        const job = (data.jobs || []).find(j => j.id === jobId || (j.jobUrl || '').includes(jobId));
        if (job) {
          const locationParts = [job.location, job.isRemote ? 'remote' : null].filter(Boolean);
          const header = locationParts.length ? `Location: ${locationParts.join(' | ')}\n\n` : '';
          const body = job.descriptionPlain || stripHtml(job.descriptionHtml || '');
          const text = [job.title || '', body].filter(Boolean).join('\n').trim();
          if (text.length > 50) {
            return { title: job.title || null, description: (header + text).substring(0, 5000) };
          }
        }
      }
    } catch {
      // Fall through to HTML scrape
    }
  }

  // Fallback: HTML scraping (no reliable title there)
  return { title: null, description: await fetchJDHtml(url) };
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║           Google Search Job Scanner — Stage 1: Collect        ║
║  Scrapes Google for Lever/Greenhouse jobs, saves to database  ║
╚════════════════════════════════════════════════════════════════╝
`);

  const db = initDatabase();
  const seenUrls = getSeenUrls(db);
  console.log(`📊 Loaded ${seenUrls.size} jobs already in database`);

  // Search
  let foundUrls = [];
  try {
    foundUrls = await scrapeGoogleSearch();
  } catch (err) {
    console.error(`❌ Google search failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`\n✅ Found ${foundUrls.length} job board URLs`);

  // Filter new
  const newUrls = foundUrls.filter(url => !seenUrls.has(url));
  console.log(`📥 ${newUrls.length} are new`);

  if (newUrls.length === 0) {
    console.log(`\n✨ No new jobs. Done!`);
    db.close();
    process.exit(0);
  }

  // Fetch + save
  console.log(`\n📝 Fetching job descriptions...\n`);

  const limit = pLimit(5); // 5 concurrent
  const today = new Date().toISOString().split('T')[0];
  let savedCount = 0;
  let errorCount = 0;

  const stmt = db.prepare(`
    INSERT INTO jobs (url, company, title, description, source, status, first_seen)
    VALUES (?, ?, ?, ?, ?, 'not_checked', ?)
  `);

  const tasks = newUrls.map((url, idx) =>
    limit(async () => {
      const company = extractCompanySlug(url);
      const source = url.includes('jobs.lever.co') ? 'lever'
        : url.includes('ashbyhq.com') ? 'ashby'
        : 'greenhouse';
      const slugTitle = url.split('/').pop().split('-').join(' '); // fallback only

      try {
        const jd = await fetchJD(url);
        stmt.run(url, company, jd.title || slugTitle, jd.description, source, today);
        console.log(`  📥 [${idx + 1}/${newUrls.length}] ${company} → saved`);
        savedCount++;
      } catch (err) {
        const errMsg = err.message || 'unknown error';
        console.log(`  ⚠️  [${idx + 1}/${newUrls.length}] ERROR ${company}: ${errMsg.substring(0, 40)}`);
        errorCount++;
      }
    })
  );

  await Promise.all(tasks);

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                      Summary                                  ║
╠════════════════════════════════════════════════════════════════╣
║ Found:  ${foundUrls.length.toString().padStart(3)} URLs                                         ║
║ New:    ${newUrls.length.toString().padStart(3)}                                             ║
║ Saved:  ${savedCount.toString().padStart(3)}                                             ║
║ Errors: ${errorCount.toString().padStart(3)}                                             ║
╚════════════════════════════════════════════════════════════════╝
`);

  console.log(`\n📋 Saved ${savedCount} new jobs (status: not_checked)`);
  console.log(`💡 Run 'node process-jobs.mjs' to evaluate and filter them.\n`);

  db.close();
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
