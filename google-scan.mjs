#!/usr/bin/env node
/**
 * google-scan.mjs — Google Search–based job scanner for early-career SWE roles
 *
 * Scrapes Google search results for Lever/Greenhouse job postings, extracts
 * experience and location requirements via Gemini, and filters for CA/Remote
 * roles requiring ≤ 2 years experience.
 *
 * Usage:
 *   node google-scan.mjs [--dry-run] [--headless] [--pages 3]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import pLimit from 'p-limit';
import { chromium } from 'playwright';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  pipeline: join(ROOT, 'data', 'pipeline.md'),
  scanHistory: join(ROOT, 'data', 'scan-history.tsv'),
  applications: join(ROOT, 'data', 'applications.md'),
};

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';
const SEARCH_QUERY = '(site:jobs.lever.co OR site:boards.greenhouse.io) "software engineer" ("new grad" OR "early career" OR "junior" OR "entry level" OR "associate")';

const CHROME_EXE = os.platform() === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : os.platform() === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
const DEBUG_PORT = 9223;

// ============================================================================
// Parse CLI args
// ============================================================================
const args = process.argv.slice(2);
let dryRun = false;
let headless = false;
let maxPages = 3;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  if (args[i] === '--headless') headless = true;
  if (args[i] === '--pages' && args[i + 1]) maxPages = parseInt(args[++i], 10);
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
  const match = url.match(/(?:jobs\.lever\.co|boards\.greenhouse\.io)\/([^\/]+)/);
  return match ? match[1] : 'unknown';
}

// ============================================================================
// Validate job URL format
// ============================================================================
function isValidJobUrl(url) {
  const leverPattern = /jobs\.lever\.co\/[^\/]+\/[^\/]+/;
  const greenhousePattern = /boards\.greenhouse\.io\/[^\/]+\/jobs\/[^\/]+/;
  return leverPattern.test(url) || greenhousePattern.test(url);
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
    const searchUrl = `${GOOGLE_SEARCH_URL}?q=${encodeURIComponent(SEARCH_QUERY)}`;
    console.log(`📍 Navigating to: ${searchUrl}\n`);

    for (let pageNum = 0; pageNum < maxPages; pageNum++) {
      const pageUrl = pageNum === 0 ? searchUrl : `${searchUrl}&start=${pageNum * 10}`;
      console.log(`  Page ${pageNum + 1}/${maxPages}...`);

      try {
        await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 45000 });
      } catch (err) {
        // Timeout or navigation error on later pages is not fatal — we may have found results already
        if (pageNum === 0) throw err; // Fail if first page doesn't load
        console.log(`    (Page ${pageNum + 1} timed out or errored, skipping)`);
        break;
      }

      // Check for CAPTCHA and wait if needed
      while (await isCaptchaOrConsentPage(page)) {
        await waitForCaptcha(page);
        await page.reload({ waitUntil: 'networkidle' });
      }

      await page.waitForTimeout(1000 + Math.random() * 1000); // random delay 1-2s

      // Extract all job board links
      const links = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors
          .map(a => a.href)
          .filter(href =>
            href.includes('jobs.lever.co') || href.includes('boards.greenhouse.io')
          );
      });

      links.forEach(url => {
        // Clean up Google redirect wrapper
        let cleanUrl = url;
        if (url.includes('url?q=')) {
          const match = url.match(/url\?q=([^&]+)/);
          if (match) {
            cleanUrl = decodeURIComponent(match[1]);
            // Strip any remaining query params
            const qIdx = cleanUrl.indexOf('?');
            if (qIdx !== -1) cleanUrl = cleanUrl.substring(0, qIdx);
          }
        }
        if (isValidJobUrl(cleanUrl)) {
          urls.add(cleanUrl);
        }
      });

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
    if (text.length > 3000) {
      text = text.substring(0, 3000) + '\n[... truncated ...]';
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
          const sections = [
            data.text || '',
            ...(data.lists || []).map(l => `${l.text}\n${stripHtml(l.content)}`),
            data.additional || '',
          ];
          const text = sections.join('\n').trim();
          if (text.length > 50) {
            return text.substring(0, 3000);
          }
        }
      }
    } catch {
      // Fall through to HTML scrape
    }
  }

  // Greenhouse API: https://boards-api.greenhouse.io/v1/boards/{company}/jobs/{jobId}
  const ghMatch = url.match(/boards\.greenhouse\.io\/([^\/?\s]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const [, company, jobId] = ghMatch;
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`, {
        headers: { 'User-Agent': CHROME_USER_AGENT },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = stripHtml(data.content || '');
        if (text.length > 50) {
          return text.substring(0, 3000);
        }
      }
    } catch {
      // Fall through
    }
  }

  // Fallback: HTML scraping
  return fetchJDHtml(url);
}

// ============================================================================
// Extract experience and location with Gemini (reuse client to avoid init overhead)
// ============================================================================
let geminiModel = null;

function initGeminiModel() {
  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-lite',
      generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
    });
  }
  return geminiModel;
}

async function extractJobMetadata(url, jdText) {
  // Check if JD fetch failed
  if (!jdText || jdText.startsWith('[Could not fetch') || jdText.startsWith('[Fetch error')) {
    return { experience_years: null, location: 'Unknown', fetchError: true };
  }

  // If JD is too short (likely API parse error or bad response), skip
  if (jdText.length < 50) {
    return { experience_years: null, location: 'Unknown', fetchError: true };
  }

  const model = initGeminiModel();

  // Debug: log JD text length
  const jdPreview = jdText.substring(0, 100).replace(/\n/g, ' ');

  const prompt = `Extract and return ONLY a JSON object, no other text:
{
  "experience_years": <number or null>,
  "location": "<string>"
}
Rules:
- "0-2 years" → 2. "2+ years" → 2. "3+ years" → 3. "no experience" → 0. unclear → null.
- location: first location mentioned or "Remote". Keep it short.

Job posting:
${jdText}`;

  const MAX_RETRIES = 3;
  let delay = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();

      // Extract JSON: match outermost braces, accounting for nested objects
      let braceCount = 0;
      let jsonStart = -1;
      let jsonEnd = -1;

      for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
          if (braceCount === 0) jsonStart = i;
          braceCount++;
        } else if (text[i] === '}') {
          braceCount--;
          if (braceCount === 0 && jsonStart !== -1) {
            jsonEnd = i + 1;
            break;
          }
        }
      }

      if (jsonStart === -1 || jsonEnd === -1) {
        return { experience_years: null, location: 'Unknown' };
      }

      const jsonStr = text.substring(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonStr);

      // Validate required fields
      if (typeof parsed === 'object' && parsed !== null) {
        return {
          experience_years: parsed.experience_years ?? null,
          location: (parsed.location && typeof parsed.location === 'string') ? parsed.location : 'Unknown',
        };
      }

      return { experience_years: null, location: 'Unknown' };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      return { experience_years: null, location: 'Unknown' };
    }
  }
}

// ============================================================================
// Filter job
// ============================================================================
function passesFilter(metadata) {
  const { experience_years, location, fetchError } = metadata;

  // If fetch failed, skip (don't evaluate on incomplete data)
  if (fetchError) return false;

  // Rule 1: experience <= 2 years (or null/unknown → keep, as unknown is assumed entry-level)
  if (experience_years !== null && experience_years > 2) {
    return false;
  }

  // Rule 2: location matches California or Remote
  const locLower = (location || '').toLowerCase();

  // California: "california", "ca" (word boundary), or specific CA cities
  const caMatch = /\bcalifornia\b|\bca\b|san francisco|los angeles|san jose|san diego|oakland|berkeley|mountain view|palo alto|cupertino/i.test(location || '');
  const remoteMatch = /\bremote\b/i.test(location || '');

  return caMatch || remoteMatch;
}

// ============================================================================
// Append to pipeline.md
// ============================================================================
function appendToPipeline(url, company, role) {
  if (!existsSync(PATHS.pipeline)) {
    writeFileSync(PATHS.pipeline, '# Pipeline\n\n## Pending\n\n');
  }

  let content = readFileSync(PATHS.pipeline, 'utf-8');

  // Find insertion point (before next ## heading or end of file)
  const insertionMatch = content.match(/^## Pending\s*$/m);
  if (!insertionMatch) {
    // Create Pending section if missing
    if (!content.includes('## Pending')) {
      content += '\n## Pending\n\n';
    }
  }

  const line = `- [ ] ${url} | ${company} | ${role}\n`;
  const pendingIndex = content.indexOf('## Pending');
  const nextHeading = content.indexOf('\n## ', pendingIndex + 1);

  if (nextHeading === -1) {
    content += line;
  } else {
    content = content.substring(0, nextHeading) + '\n' + line + content.substring(nextHeading);
  }

  writeFileSync(PATHS.pipeline, content);
}

// ============================================================================
// Append to scan-history.tsv
// ============================================================================
function appendToScanHistory(url, title, company, status, location) {
  const now = new Date().toISOString().split('T')[0];

  if (!existsSync(PATHS.scanHistory)) {
    writeFileSync(PATHS.scanHistory, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n');
  }

  const line = `${url}\t${now}\tgoogle-search\t${title}\t${company}\t${status}\t${location}\n`;
  appendFileSync(PATHS.scanHistory, line);
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║           Google Search Job Scanner                           ║
║  Early-career SWE roles (CA + Remote, ≤2 years experience)    ║
╚════════════════════════════════════════════════════════════════╝
`);

  const seenUrls = loadSeenUrls();
  console.log(`📊 Loaded ${seenUrls.size} previously seen URLs`);

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
  console.log(`📥 ${newUrls.length} are new (not in history)`);

  if (newUrls.length === 0) {
    console.log(`\n✨ No new jobs to process. Done!`);
    process.exit(0);
  }

  // Fetch + evaluate
  console.log(`\n🔄 Fetching and evaluating...\n`);

  const limit = pLimit(5); // 5 concurrent
  let passCount = 0;
  let filteredCount = 0;
  let errorCount = 0;
  const errors = [];

  const tasks = newUrls.map((url, idx) =>
    limit(async () => {
      const company = extractCompanySlug(url);
      const roleTitle = url.split('/').pop().split('-').join(' ');

      try {
        const jdText = await fetchJD(url);
        const metadata = await extractJobMetadata(url, jdText);

        if (passesFilter(metadata)) {
          console.log(`  ✅ [${idx + 1}/${newUrls.length}] ${company} | ${roleTitle.substring(0, 50)}`);
          appendToPipeline(url, company, roleTitle);
          appendToScanHistory(url, roleTitle, company, 'added', metadata.location);
          passCount++;
        } else {
          const reason = metadata.fetchError ? 'fetch-error' : `exp=${metadata.experience_years}, loc=${metadata.location}`;
          console.log(`  ❌ [${idx + 1}/${newUrls.length}] SKIP ${company} | ${reason}`);
          appendToScanHistory(url, roleTitle, company, 'skipped_filtered', metadata.location || 'Unknown');
          filteredCount++;
        }
      } catch (err) {
        const errMsg = err.message || 'unknown error';
        console.log(`  ⚠️  [${idx + 1}/${newUrls.length}] ERROR ${company}: ${errMsg.substring(0, 50)}`);
        errors.push({ company, url, error: errMsg });
        appendToScanHistory(url, roleTitle, company, 'skipped_error', 'Unknown');
        errorCount++;
      }
    })
  );

  await Promise.all(tasks);

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                      Summary                                  ║
╠════════════════════════════════════════════════════════════════╣
║ Found: ${foundUrls.length.toString().padStart(3)} URLs                                          ║
║ New:   ${newUrls.length.toString().padStart(3)}                                             ║
║ Passed filter: ${passCount.toString().padStart(3)}                                     ║
║ Filtered out:  ${filteredCount.toString().padStart(3)}                                    ║
║ Errors:        ${errorCount.toString().padStart(3)}                                     ║
╚════════════════════════════════════════════════════════════════╝
`);

  if (passCount > 0) {
    console.log(`✨ Added ${passCount} jobs to ${PATHS.pipeline}`);
  }

  if (errors.length > 0) {
    console.log(`\n⚠️  ${errors.length} jobs had errors (check API quota/network):`);
    errors.forEach(({ company, error }) => {
      console.log(`   - ${company}: ${error.substring(0, 60)}`);
    });
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
