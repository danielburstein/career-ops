#!/usr/bin/env node
/**
 * apply-jobs.mjs — Stage 3: Apply to Verified Jobs (per-site pipelines)
 *
 * Reads jobs with status='verified' from data/jobs.db and walks each one
 * through a site-aware apply flow (Lever and Greenhouse are set up differently):
 *
 *   1. Open the job page, WAIT for user: continue / skip / quit
 *   2. Site prep — make sure the application form is visible so Simplify can run
 *      (Lever: go to {url}/apply; Greenhouse: form is usually inline, click Apply if not)
 *   3. Trigger the Simplify extension's autofill and wait for it to finish
 *   4. Scan the form → array of required questions Simplify couldn't answer
 *   5. Answer each via static rules → Gemini (profile + response style) → manual
 *   6. Fill the answers into the form
 *   7. WAIT for the user to review and click Submit themselves → mark applied
 *
 * Usage:
 *   node apply-jobs.mjs [--limit N] [--job <id>] [--chrome-profile "Profile 6"] [--refresh-profile]
 *     --limit 1   apply to just the first verified job (test run)
 *     --job 31    apply to a specific job by its DB id (any status)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { classifyLiveness } from './liveness-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  db: join(ROOT, 'data', 'jobs.db'),
  screenshots: join(ROOT, 'batch', 'apply-screenshots'),
  profileContext: join(ROOT, 'profile_context.md'),
  cv: join(ROOT, 'cv.md'),
  responseStyle: join(ROOT, 'response_style.md'),
};

const CHROME_EXE = os.platform() === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : os.platform() === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome';
const DEBUG_PORT = 9223;

// Quality-first for real application answers, lite as fallback. Both survive
// model retirements because they're floating aliases.
const ANSWER_MODELS = [
  process.env.GEMINI_APPLY_MODEL || 'gemini-flash-latest',
  process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',
];

const STATIC_ANSWERS = [
  [/legally authorized to work|authorized to work in/i, 'Yes'],
  // Only yes/no sponsorship questions — "visa status" / "citizenship status" questions
  // must go to Gemini (a status question can't be answered "No")
  [/will you now or in the future require|require.{0,30}sponsorship|need.{0,20}(a\s)?visa\b|sponsorship/i, 'No'],
  [/university|school you are currently attending/i, 'University of California, San Diego'],
  // \b so "P-referred- Name" doesn't match
  [/know anyone|\breferral\b|\breferred\b/i, 'No'],
  [/gpa/i, '3.2'],
  [/hybrid|in.?office|on.?site|commit to.*policy/i, 'Yes'],
  [/how did you hear|source|found.*us/i, 'LinkedIn'],
  [/years of.*experience|relevant.*experience/i, '2'],
  [/willing to relocate|relocat/i, 'No'],
];

// CLI
const args = process.argv.slice(2);
let chromeProfile = 'Profile 6';
let refreshProfile = false;
let limitJobs = 0;      // 0 = no limit
let targetJobId = null; // apply to one specific job id
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--chrome-profile' && args[i + 1]) chromeProfile = args[++i];
  if (args[i] === '--refresh-profile') refreshProfile = true;
  if (args[i] === '--limit' && args[i + 1]) limitJobs = parseInt(args[++i], 10) || 0;
  if (args[i] === '--job' && args[i + 1]) targetJobId = parseInt(args[++i], 10);
}

// ============================================================================
// Utility: prompt
// ============================================================================
async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// Chrome profile + launch helpers
// ============================================================================
function getChromePath() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32': return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default: return path.join(home, '.config', 'google-chrome');
  }
}

function getAutomationDataDir() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32': return path.join(home, 'AppData', 'Local', 'Google', 'ChromeForAutomation');
    case 'darwin': return path.join(home, 'Library', 'Application Support', 'Google', 'ChromeForAutomation');
    default: return path.join(home, '.config', 'google-chrome-automation');
  }
}

function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      try { copyFileSync(srcPath, destPath); } catch { /* locked files are non-fatal */ }
    }
  }
}

function ensureAutomationProfile(sourceProfile) {
  const automationDir = getAutomationDataDir();
  const destProfile = path.join(automationDir, 'Default');

  if (existsSync(destProfile) && !refreshProfile) return automationDir;

  if (refreshProfile && existsSync(destProfile)) {
    console.log('  Refreshing automation profile...');
    rmSync(destProfile, { recursive: true, force: true });
  }

  console.log('  Setting up automation profile (may take 30 seconds)...');
  mkdirSync(destProfile, { recursive: true });
  copyDirSync(path.join(getChromePath(), sourceProfile), destProfile);
  writeFileSync(path.join(automationDir, 'Local State'), JSON.stringify({ profile: { last_used: 'Default' } }));
  console.log('  ✅ Automation profile ready\n');
  return automationDir;
}

function clearChromeCrashState(baseDir, profileFolder) {
  const prefsPath = path.join(baseDir, profileFolder, 'Preferences');
  if (!existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
    if (prefs?.profile) {
      prefs.profile.exit_type = 'Normal';
      prefs.profile.exited_cleanly = true;
      writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch { /* non-fatal */ }
}

async function killChrome() {
  try {
    if (os.platform() === 'win32') {
      execSync('taskkill /IM chrome.exe /F 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill -9 chrome', { stdio: 'ignore' });
    }
  } catch { /* not running */ }
  await new Promise(r => setTimeout(r, 2000));
}

async function launchChrome(userDataDir) {
  console.log('🚀 Launching Chrome...');
  spawn(CHROME_EXE, [
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-features=Translate',
  ], { detached: true, stdio: 'ignore' }).unref();

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
      if (res.ok) {
        console.log('  ✅ Chrome ready\n');
        return;
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Chrome did not start within 20s');
}

async function connectChrome() {
  const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
  const context = browser.contexts()[0];
  return { browser, context };
}

// ============================================================================
// Dead-posting detection — reuses the shared liveness classifier so "Job not
// found" / "position has been filled" pages get skipped instead of walking
// through Simplify + question scanning on a dead page.
// ============================================================================
async function detectDeadPosting(page, status = 0) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const cls = classifyLiveness({ status, finalUrl: page.url(), bodyText, applyControls: [] });
    // Only hard signals auto-skip — soft ones (short content, no apply button)
    // stay with the user, since SPAs can just be slow to render
    if (cls.result === 'expired' && ['http_gone', 'expired_url', 'expired_body'].includes(cls.code)) {
      return cls.reason;
    }
  } catch {}
  return null;
}

// ============================================================================
// Form visibility helper
// ============================================================================
async function hasFormFields(page) {
  return page.evaluate(() =>
    document.querySelectorAll('[required], [aria-required="true"]').length > 0
  ).catch(() => false);
}

async function waitForFormFields(page, timeout = 8000) {
  return page.waitForFunction(
    () => document.querySelectorAll('[required], [aria-required="true"]').length > 0,
    { timeout }
  ).then(() => true).catch(() => false);
}

// ============================================================================
// Site pipelines — each knows how to get its form ready for Simplify
// ============================================================================

// Lever: the posting page is just the description; the form lives at {url}/apply.
async function prepareLever(page, job) {
  if (await hasFormFields(page)) return true;

  const applyUrl = job.url.replace(/\/$/, '') + '/apply';
  console.log(`  🧭 Lever: navigating to apply form (${applyUrl})`);
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  if (await waitForFormFields(page, 8000)) return true;

  // Fallback: click the posting page's Apply button
  console.log('  🔍 Lever: /apply had no form, trying Apply button...');
  await page.goto(job.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const btn = page.locator('a:has-text("Apply for this job"), .postings-btn, a:has-text("Apply")').first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    return waitForFormFields(page, 8000);
  }
  return false;
}

// Greenhouse: the form is usually inline on the job page; some boards hide it
// behind an Apply button/tab.
async function prepareGreenhouse(page, job) {
  if (await hasFormFields(page)) return true;

  console.log('  🔍 Greenhouse: form not visible, trying Apply button...');
  // Exclude "Quick Apply with MyGreenhouse" — it navigates to a MyGreenhouse
  // login/OAuth page, abandoning the inline application form.
  const btn = page.locator(
    '#apply_button, a[href*="#app"], button:has-text("Apply Now"), button:has-text("Apply"), a:has-text("Apply Now"), a:has-text("Apply")'
  ).filter({ hasNotText: /MyGreenhouse|Quick Apply/i }).first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click().catch(() => {});
    if (await waitForFormFields(page, 8000)) return true;
  }
  return hasFormFields(page);
}

// Ashby: React SPA. The application form lives at {url}/application; the posting
// page has an "Apply for this job" button that routes there client-side. The DB
// URL is normalized (no /application suffix), so we append it.
async function prepareAshby(page, job) {
  if (await hasFormFields(page)) return true;

  const applyUrl = job.url.replace(/\/$/, '') + '/application';
  console.log(`  🧭 Ashby: navigating to apply form (${applyUrl})`);
  // Ashby hydrates slowly and lazy-loads the form — networkidle + a longer wait
  await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  if (await waitForFormFields(page, 12000)) return true;

  // Fallback: posting page → click "Apply for this job"
  console.log('  🔍 Ashby: form not visible, trying Apply button...');
  await page.goto(job.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  const btn = page.locator(
    'a:has-text("Apply for this job"), button:has-text("Apply for this job"), a:has-text("Apply"), button:has-text("Apply")'
  ).first();
  if (await btn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await btn.click();
    return waitForFormFields(page, 12000);
  }
  return hasFormFields(page);
}

// Unknown portals: generic best-effort (old clickApplyIfNeeded behavior)
async function prepareGeneric(page) {
  if (await hasFormFields(page)) return true;
  const btn = page.locator('a:has-text("Apply"), button:has-text("Apply"), [data-qa="btn-apply"], .template-btn-submit').first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    return waitForFormFields(page, 8000);
  }
  return false;
}

const SITE_PIPELINES = {
  lever: { name: 'Lever', prepare: prepareLever },
  greenhouse: { name: 'Greenhouse', prepare: prepareGreenhouse },
  ashby: { name: 'Ashby', prepare: prepareAshby },
};

function detectSite(job) {
  if (SITE_PIPELINES[job.source]) return { key: job.source, ...SITE_PIPELINES[job.source] };
  if (/jobs\.lever\.co/.test(job.url)) return { key: 'lever', ...SITE_PIPELINES.lever };
  if (/greenhouse\.io/.test(job.url)) return { key: 'greenhouse', ...SITE_PIPELINES.greenhouse };
  if (/ashbyhq\.com/.test(job.url)) return { key: 'ashby', ...SITE_PIPELINES.ashby };
  return { key: 'generic', name: 'Unknown portal', prepare: prepareGeneric };
}

// ============================================================================
// Simplify extension: trigger autofill (shadow DOM traversal) and wait
// ============================================================================

// Greenhouse job-boards pages are React SPAs that re-render/navigate shortly
// after load — an in-flight page.evaluate then throws "Execution context was
// destroyed". Retry through those transient navigations instead of aborting.
async function safeEvaluate(page, fn, arg, { retries = 6, waitMs = 700 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      const transient = /context was destroyed|execution context|because of a navigation|frame (was |got )?detached/i.test(e.message || '');
      if (!transient || i >= retries) throw e;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(waitMs);
    }
  }
}

async function triggerSimplifyAutofill(page, maxRetries = 10) {
  console.log('  🔍 Searching for Simplify Autofill button...');

  // Let any post-load SPA navigation settle before we start poking the DOM
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(800);

  for (let i = 0; i < maxRetries; i++) {
    const coords = await safeEvaluate(page, () => {
      function findButton(root) {
        for (const el of root.querySelectorAll('button, [role="button"]')) {
          if (/autofill this page/i.test(el.textContent)) {
            const rect = el.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            const found = findButton(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      return findButton(document);
    });

    if (coords && coords.x > 0 && coords.y > 0) {
      await page.mouse.click(coords.x, coords.y).catch(() => {});

      // Verify the click activated Simplify (button should disappear)
      await page.waitForTimeout(1500);
      const stillPresent = await safeEvaluate(page, () => {
        function findButton(root) {
          for (const el of root.querySelectorAll('button, [role="button"]')) {
            if (/autofill this page/i.test(el.textContent)) return true;
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot && findButton(el.shadowRoot)) return true;
          }
          return false;
        }
        return findButton(document);
      });

      if (!stillPresent) {
        console.log('  ✅ Simplify Autofill triggered');
        return true;
      }
      console.log(`  🔄 Button still present, retrying (${i + 1}/${maxRetries})...`);
    }

    await page.waitForTimeout(600);
  }

  console.log('  ⚠️  Could not find/activate Simplify Autofill button');
  return false;
}

async function waitForSimplify(page, timeoutMs = 60000) {
  // Watch everything Simplify can touch: all input types (url, untyped, …),
  // radio/checkbox states, and React-Select commits — those live in a
  // .select__single-value div while the inner input stays empty, so an
  // input-only snapshot misses Country/Location being filled entirely.
  const takeSnapshot = () => page.evaluate(() => {
    const vals = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => !['hidden', 'submit', 'button', 'file'].includes((el.type || '').toLowerCase()))
      .map(el => (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '0') : el.value);
    const widgetVals = [...document.querySelectorAll('[class*="single-value"], [class*="singleValue"]')]
      .map(el => el.textContent || '');
    return [...vals, ...widgetVals].join('|');
  }).catch(() => '');

  // Baseline BEFORE triggering: only growth beyond this proves Simplify started.
  const baseline = await takeSnapshot();

  const clicked = await triggerSimplifyAutofill(page);
  if (!clicked) {
    console.log('  Proceeding without Simplify...');
    return;
  }

  console.log('  ⏳ Waiting for Simplify to finish filling...');

  // Simplify's popup is the real progress signal. While autofilling it shows a
  // persistent footer — "Autofilling" + "Pause" / "Skip to next input" — with the
  // main line cycling "Filling location…", "Filling 1 of 1 education…",
  // "Filling ethnicity…". That footer stays up through the whole run, including
  // the long pauses on slow widgets, so its PRESENCE means "still working" and
  // its DISAPPEARANCE means done — far more reliable than watching the form,
  // where a 15s gap between two fields looks identical to finished.
  const readSimplifyBusy = () => page.evaluate(() => {
    const scan = root => {
      for (const el of root.querySelectorAll('*')) {
        if (el.childElementCount === 0) {
          const t = (el.textContent || '').trim();
          // "Skip to next input" and "Autofilling" are unique to Simplify's active
          // popup; "Filling …" covers the cycling status line.
          if (/^autofilling$/i.test(t)
            || /skip to next input/i.test(t)
            || /^filling\b.*(\.{3}|…)/i.test(t)
            || /^filling \d+ of \d+/i.test(t)) return true;
        }
        if (el.shadowRoot && scan(el.shadowRoot)) return true;
      }
      return false;
    };
    return scan(document);
  }).catch(() => false);

  // Done = Simplify's busy footer was seen and has now stayed gone for a short
  // confirmation window (guards against a flicker between two fields). The form
  // snapshot is only a fallback for the rare case the popup can't be read at all.
  const GONE_CONFIRM_MS = 3000;  // busy footer absent this long after being seen → done
  const QUIET_MS = 40000;        // fallback: form untouched this long, popup never read
  const NO_START_MS = 30000;     // never busy AND never changed → Simplify didn't run
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(timeoutMs, 180000);
  let lastSnapshot = baseline;
  let lastChangeAt = null;
  let sawBusy = false;
  let busyGoneAt = null;

  while (Date.now() < deadline) {
    const busy = await readSimplifyBusy();
    const snapshot = await takeSnapshot();
    if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; lastChangeAt = Date.now(); }

    if (busy) {
      sawBusy = true;
      busyGoneAt = null;
    } else if (sawBusy) {
      // Primary signal: the busy footer we were watching has vanished
      if (busyGoneAt === null) busyGoneAt = Date.now();
      if (Date.now() - busyGoneAt >= GONE_CONFIRM_MS) {
        console.log('  ✅ Simplify finished (autofill popup closed)');
        await page.waitForTimeout(1000); // let the final field commit
        return;
      }
    }

    if (!sawBusy) {
      // Fallback path — popup never readable this run
      if (lastChangeAt !== null && Date.now() - lastChangeAt >= QUIET_MS) {
        console.log(`  ✅ Simplify finished (form settled for ${QUIET_MS / 1000}s)`);
        return;
      }
      if (lastChangeAt === null && Date.now() - startedAt >= NO_START_MS) {
        console.log('  ⚠️  No Simplify activity in 30s — it may not have run; proceeding with gap-fill');
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  console.log('  ⚠️  Simplify timed out — proceeding with gap-fill');
}

// ============================================================================
// CAPTCHA detection
//
// CAPTCHAs are a human-presence check by design, so this script does NOT try to
// solve them — you're already in the loop reviewing every application. Instead it
// makes the handoff painless: it grabs your attention (terminal bell + brings the
// Chrome tab forward), then auto-resumes the moment you've solved it. No need to
// watch the terminal or press Enter unless you want to force past it.
// ============================================================================
async function detectCaptcha(page) {
  return page.evaluate(() => {
    const isVisible = el => !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 0);
    if (document.querySelector('iframe[src*="turnstile"]')) return 'Cloudflare Turnstile';
    if (document.querySelector('iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]')) return 'Arkose / FunCaptcha';
    if (document.querySelector('.cf-challenge-running')) return 'Cloudflare challenge';
    const hcaptcha = document.querySelector('[class*="hcaptcha"]');
    if (hcaptcha && isVisible(hcaptcha)) return 'hCaptcha';
    const recaptchaChallenge = document.querySelector('iframe[src*="recaptcha"][src*="bframe"]');
    if (recaptchaChallenge && isVisible(recaptchaChallenge)) return 'reCAPTCHA';
    const captchaIframe = document.querySelector('iframe[src*="captcha"]:not([src*="recaptcha"])');
    if (captchaIframe && isVisible(captchaIframe)) return 'CAPTCHA';
    return null;
  }).catch(() => null);
}

async function waitForCaptchaIfNeeded(page) {
  const type = await detectCaptcha(page);
  if (!type) return;

  console.log(`\n  🔒 ${type} detected — this needs a human (that's the whole point).`);
  console.log('     Solve it in the Chrome window; I\'ll continue automatically when it clears.');
  console.log('     (or press Enter to force past it)');

  // Bring the browser to the foreground so the challenge is right in front of you
  await page.bringToFront().catch(() => {});

  // Let the user force-continue by pressing Enter at any point
  let forced = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('  > ', () => { forced = true; rl.close(); });

  // Poll until the CAPTCHA clears, beeping every few seconds so you notice it
  const started = Date.now();
  let ticks = 0;
  while (!forced) {
    if (ticks % 3 === 0) process.stdout.write('\x07'); // terminal bell every ~3s
    ticks++;

    await page.waitForTimeout(1000);
    const still = await detectCaptcha(page);
    if (!still) {
      rl.close();
      console.log('  ✅ CAPTCHA cleared — continuing.\n');
      return;
    }
    if (Date.now() - started > 5 * 60 * 1000) { // 5-min safety valve
      rl.close();
      console.log('  ⏱️  Still present after 5 min — continuing anyway.\n');
      return;
    }
  }
  console.log('  ⏭️  Continuing (forced).\n');
}

// ============================================================================
// Scan for required fields Simplify couldn't answer
// ============================================================================
async function scanUnfilledFields(page, { includeOptional = false } = {}) {
  const unfilled = await page.evaluate((includeOptional) => {
    const requiredSel = '[required], [aria-required="true"]';
    const required = [...document.querySelectorAll(requiredSel)];
    const isRequiredEl = el => el.matches(requiredSel) || !!el.closest(requiredSel);

    function getVisibleValue(el) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') return el.value?.trim() || '';
      if (tag === 'textarea') return el.value?.trim() || '';
      if (tag === 'input') {
        if (el.value?.trim()) return el.value.trim();
        const valueContainer = el.closest('[class*="ValueContainer"], [class*="value-container"], [class*="control"]');
        if (valueContainer) {
          if (valueContainer.querySelector('[class*="singleValue"], [class*="single-value"], [class*="selectedValue"]')) return 'filled';
          if (valueContainer.querySelector('[class*="placeholder"], [class*="Placeholder"]')) return '';
        }
        return '';
      }
      if (el.querySelector('[class*="singleValue"], [class*="single-value"], [class*="selectedValue"]')) return 'filled';
      if (el.querySelector('[class*="placeholder"], [class*="Placeholder"]')) return '';
      const innerInput = el.querySelector('input');
      if (innerInput?.value?.trim()) return innerInput.value.trim();
      const rawText = el.textContent?.replace(/[×✕▾▼]/g, '').trim() || '';
      if (rawText && !/^select\.{0,3}$/i.test(rawText) && rawText.length > 1) return rawText;
      return '';
    }

    function findPrecedingLabel(el) {
      let node = el;
      while (node && node.tagName !== 'BODY') {
        let sib = node.previousElementSibling;
        while (sib) {
          const isLabel = sib.matches('.application-label, .text, .application-question-text, label');
          const labelEl = isLabel ? sib : sib.querySelector('.application-label, .text, .application-question-text');
          const text = labelEl?.textContent?.trim();
          if (text) return text.replace(/\n/g, ' ').replace(/\s+/g, ' ');
          sib = sib.previousElementSibling;
        }
        if (node.tagName === 'LI') break;
        node = node.parentElement;
      }
      return '';
    }

    // --- Text inputs / selects / textareas
    // Optional pass: also sweep visible, empty, non-required controls inside the
    // form. Best-effort — custom div widgets are only detected when they carry
    // aria-required, and unlabeled junk is filtered out after label resolution.
    let textCandidates = required;
    if (includeOptional) {
      const optionalControls = [...document.querySelectorAll('form input, form select, form textarea')]
        .filter(el =>
          !isRequiredEl(el) &&
          el.offsetParent !== null &&
          !el.closest('[class*="consent"], [class*="Consent"]') &&
          !['hidden', 'submit', 'button', 'file', 'search'].includes((el.type || '').toLowerCase())
        );
      textCandidates = [...required, ...optionalControls];
    }
    const textFields = textCandidates
      .filter(el => {
        const tag = el.tagName.toLowerCase();
        const type = (el.type || '').toLowerCase();
        if (tag === 'input' && type === 'hidden') return false;
        if (type === 'radio' || type === 'checkbox') return false;
        if (el.parentElement && el.parentElement.closest('[required], [aria-required="true"]')) return false;
        const value = getVisibleValue(el);
        return value === '' || /^select\.{0,3}$/i.test(value);
      })
      .map(el => {
        const id = el.id || el.name;
        const labelEl = id
          ? document.querySelector(`label[for="${id}"]`)
          : el.closest('label') || el.previousElementSibling;

        let cleanLabel = labelEl?.textContent?.trim() || el.placeholder || el.name || 'Unknown';
        cleanLabel = cleanLabel.replace(/\n/g, ' ').replace(/\s+/g, ' ');

        if (!cleanLabel || /^(select\.{0,3}|unknown)$/i.test(cleanLabel) || /^(cards|urls|eeo)\[/i.test(cleanLabel) || /^type your response$/i.test(cleanLabel)) {
          const preceding = findPrecedingLabel(el);
          if (preceding) cleanLabel = preceding;
        }

        if (/^(yes|no|true|false)$/i.test(cleanLabel)) {
          const formGroup = el.closest('li, [class*="question"], fieldset');
          const overarchingLabel = formGroup?.querySelector('.application-label, legend, .text')?.textContent?.trim();
          if (overarchingLabel) cleanLabel = overarchingLabel.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        }

        if (/^cards\[/i.test(cleanLabel) && el.tagName.toLowerCase() === 'select') {
          const optionsText = Array.from(el.options).slice(1, 6).map(o => o.text).join(' ');
          if (/university|college/i.test(optionsText)) {
            cleanLabel = 'University';
          } else if (/job board|linkedin|referral|friend|glassdoor|heard/i.test(optionsText)) {
            cleanLabel = 'How did you hear about this opportunity?';
          }
        }

        return {
          label: cleanLabel,
          type: el.tagName.toLowerCase(),
          inputType: el.type || '',
          id: el.id || '',
          name: el.name || '',
          ariaHasPopup: el.getAttribute('aria-haspopup') || '',
          required: isRequiredEl(el),
        };
      })
      // Optional controls without a resolvable label are widget junk, not questions
      .filter(f => f.required || (f.label && !/^(unknown|select\.{0,3})$/i.test(f.label)));

    // --- Radio/checkbox grouping
    const radioByName = new Map();
    const checkboxByKey = new Map();

    // Optional pass sweeps non-required groups too; Ashby markup is excluded here
    // because its dedicated passes below handle it (labels live on question titles)
    let rcCandidates = required;
    if (includeOptional) {
      const optionalRc = [...document.querySelectorAll('form input[type="radio"], form input[type="checkbox"]')]
        .filter(el =>
          !isRequiredEl(el) &&
          !el.closest('[class*="ashby"], [class*="consent"], [class*="Consent"]')
        );
      rcCandidates = [...required, ...optionalRc];
    }
    for (const el of rcCandidates) {
      const type = (el.type || '').toLowerCase();
      if (type !== 'radio' && type !== 'checkbox') continue;
      const key = el.name ||
        el.closest('fieldset')?.id ||
        el.closest('[role="group"]')?.id ||
        'anon_' + (el.closest('li, [class*="question"]')?.textContent?.slice(0, 30) || String(Math.random()));
      const map = type === 'radio' ? radioByName : checkboxByKey;
      if (!map.has(key)) map.set(key, { elements: [], anyChecked: false, name: el.name || '', required: false });
      const g = map.get(key);
      g.elements.push(el);
      if (el.checked) g.anyChecked = true;
      if (isRequiredEl(el)) g.required = true;
    }

    function getGroupLabel(firstEl) {
      const preceding = findPrecedingLabel(firstEl);
      if (preceding) return preceding;
      const c = firstEl.closest('fieldset, [role="group"], [class*="question"], li');
      if (!c) return '';
      const lev = c.querySelector('.application-label, legend, .text, .application-question-text');
      return (lev?.textContent?.trim() || '').replace(/\n/g, ' ').replace(/\s+/g, ' ');
    }

    function getOptionLabels(elements) {
      return elements.map(el => {
        const id = el.id;
        const lbl = id
          ? document.querySelector(`label[for="${id}"]`)?.textContent?.trim()
          : el.closest('label')?.textContent?.trim();
        return lbl || el.value || '';
      }).filter(Boolean);
    }

    const radioFields = [...radioByName.values()]
      .filter(g => !g.anyChecked)
      .map(g => ({
        label: getGroupLabel(g.elements[0]) || g.name || 'Unknown',
        type: 'input',
        inputType: 'radio',
        id: '',
        name: g.name,
        ariaHasPopup: '',
        options: getOptionLabels(g.elements),
        optionIds: g.elements.map(el => el.id || ''),
        required: g.required,
      }));

    const checkboxFields = [...checkboxByKey.values()]
      .filter(g => !g.anyChecked)
      .map(g => ({
        label: getGroupLabel(g.elements[0]) || g.name || 'Unknown',
        type: 'input',
        inputType: 'checkbox',
        id: '',
        name: g.name,
        ariaHasPopup: '',
        options: getOptionLabels(g.elements),
        optionIds: g.elements.map(el => el.id || ''),
        required: g.required,
      }));

    // --- Ashby: requiredness is a `_required_` class on the question-title label,
    // not an attribute on the inputs — so its radio/checkbox groups are invisible
    // to the [required] passes above. Scan its field entries directly.
    // Radio-group questions render as bare <fieldset class="_fieldEntry_...">
    // WITHOUT the semantic field-entry class, so sweep all fieldsets too — the
    // question-title check below gates out non-Ashby ones.
    const ashbyEntries = [...new Set([
      ...document.querySelectorAll('.ashby-application-form-field-entry'),
      ...document.querySelectorAll('fieldset'),
    ])];
    const ashbyFields = [];
    for (const entry of ashbyEntries) {
      // Survey fieldsets are handled by the survey pass below (optionalSurvey flag);
      // nested fieldsets are already covered by their parent field entry
      if (entry.closest('.ashby-survey-form-container')) continue;
      if (entry.parentElement?.closest('.ashby-application-form-field-entry')) continue;
      const titleEl = entry.querySelector('.ashby-application-form-question-title');
      if (!titleEl) continue;
      const entryRequired = /required/i.test(titleEl.className || '');
      if (!entryRequired && !includeOptional) continue;
      const label = (titleEl.textContent || '').trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
      if (!label) continue;

      // Exclude SMS/contact-consent widgets nested inside other fields (e.g. Phone) —
      // consent choices are the user's to make, not the bot's
      const notConsent = el => !el.closest('[class*="consent"], [class*="Consent"]');

      // Ashby yes/no segmented buttons: visible <button class="_option_...">s with a
      // hidden checkbox as state-holder. The selected button gains an `_active_` class;
      // the checkbox stays unchecked even when "No" is selected, so buttons are the truth.
      const optionButtons = [...entry.querySelectorAll('button[class*="_option_"]')].filter(notConsent);
      if (optionButtons.length >= 2) {
        const answered = optionButtons.some(b => /active|selected/i.test((b.className || '').toString()));
        if (!answered) {
          ashbyFields.push({
            label, type: 'input', inputType: 'ashby-buttons', id: '',
            name: entry.getAttribute('data-field-path') || '',
            ariaHasPopup: '', required: entryRequired,
            options: optionButtons.map(b => (b.textContent || '').trim()).filter(Boolean),
          });
        }
        continue;
      }

      const radios = [...entry.querySelectorAll('input[type="radio"]')].filter(notConsent);
      if (radios.length > 0) {
        if (!radios.some(r => r.checked)) {
          ashbyFields.push({
            label, type: 'input', inputType: 'radio', id: '', name: radios[0].name || '', ariaHasPopup: '',
            required: entryRequired,
            // labels are `for=`-linked siblings (not wrappers) and inputs have no value —
            // getOptionLabels resolves label[for=id] first
            options: getOptionLabels(radios),
            optionIds: radios.map(r => r.id || ''),
          });
        }
        continue;
      }
      const checks = [...entry.querySelectorAll('input[type="checkbox"]')].filter(notConsent);
      if (checks.length > 0 && !checks.some(c => c.checked)) {
        ashbyFields.push({
          label, type: 'input', inputType: 'checkbox', id: '', name: checks[0].name || '', ariaHasPopup: '',
          required: entryRequired,
          options: getOptionLabels(checks),
          optionIds: checks.map(c => c.id || ''),
        });
      }
    }

    // --- Ashby optional diversity/EEO survey (ashby-survey-form-container).
    // Only demographic-looking questions are surfaced; answers come from the
    // "Demographic / EEO Survey Answers" section of apply-agent.md.
    const DEMOGRAPHIC = /\bage\b|\bgender\b|transgender|sexual orientation|ethnic|\brace\b|racial|veteran|disab|communit|hispanic|latin|lgbtq|pronoun/i;
    for (const survey of document.querySelectorAll('.ashby-survey-form-container')) {
      for (const entry of survey.querySelectorAll('fieldset, [class*="fieldEntry"]')) {
        const titleEl = entry.querySelector('.ashby-application-form-question-title');
        const label = (titleEl?.textContent || '').trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
        if (!label || !DEMOGRAPHIC.test(label)) continue;

        // Note: survey checkboxes have name="<option label>" (no shared group name),
        // so per-option ids are the only reliable click targets
        const radios = [...entry.querySelectorAll('input[type="radio"]')];
        if (radios.length > 0) {
          if (!radios.some(r => r.checked)) {
            ashbyFields.push({
              label, type: 'input', inputType: 'radio', id: '', name: radios[0].name || '', ariaHasPopup: '',
              required: false,
              options: getOptionLabels(radios), optionIds: radios.map(r => r.id || ''), optionalSurvey: true,
            });
          }
          continue;
        }
        const checks2 = [...entry.querySelectorAll('input[type="checkbox"]')];
        if (checks2.length > 0 && !checks2.some(c => c.checked)) {
          ashbyFields.push({
            label, type: 'input', inputType: 'checkbox', id: '', name: checks2[0].name || '', ariaHasPopup: '',
            required: false,
            options: getOptionLabels(checks2), optionIds: checks2.map(c => c.id || ''), optionalSurvey: true,
          });
        }
      }
    }

    return [...textFields, ...radioFields, ...checkboxFields, ...ashbyFields];
  }, includeOptional);

  // Dedup by label, upgrading id/name when a later duplicate has one
  const uniqueUnfilled = [];
  const seenLabels = new Map();
  for (const field of unfilled) {
    if (!seenLabels.has(field.label)) {
      seenLabels.set(field.label, field);
      uniqueUnfilled.push(field);
    } else {
      const existing = seenLabels.get(field.label);
      existing.required = existing.required || field.required;
      if (!existing.id && !existing.name && (field.id || field.name)) {
        existing.id = field.id;
        existing.name = field.name;
        existing.type = field.type;
      }
    }
  }
  return uniqueUnfilled;
}

// ============================================================================
// Answer cache — reuse answers to questions already answered on past applications
// ============================================================================
function initAnswerCache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS answer_cache (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      question_norm TEXT UNIQUE NOT NULL,
      question_raw  TEXT NOT NULL,
      answer        TEXT NOT NULL,
      source        TEXT,
      use_count     INTEGER DEFAULT 0,
      created_at    TEXT,
      last_used_at  TEXT
    )
  `);
}

function normalizeQuestion(q) {
  return (q || '')
    .toLowerCase()
    .replace(/\(required\)|\(optional\)|[*✱]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUESTION_STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'you', 'your', 'of', 'in', 'on', 'at',
  'to', 'for', 'and', 'or', 'do', 'does', 'did', 'what', 'which', 'please', 'tell',
  'us', 'me', 'about', 'with', 'that', 'this', 'have', 'has', 'be', 'if', 'any',
  // question-framing words that don't change what's being asked
  'describe', 'share', 'explain', 'give', 'provide', 'list', 'briefly', 'most', 'especially', 'question',
]);

function questionTokens(norm) {
  return new Set(norm.split(' ').filter(t => t.length > 1 && !QUESTION_STOPWORDS.has(t)));
}

// Similarity = max(jaccard, containment). Containment catches paraphrases with extra
// verbiage but needs ≥ 2 shared meaningful tokens to avoid one-word false positives.
function questionSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const jaccardScore = inter / (a.size + b.size - inter);
  const containment = inter >= 2 ? inter / Math.min(a.size, b.size) : 0;
  return Math.max(jaccardScore, containment);
}

// Questions whose answers must NOT be reused across companies
function isCompanySpecific(label, company) {
  if (company && label.toLowerCase().includes(String(company).toLowerCase())) return true;
  return /why (do you want|are you excited|are you interested|would you like|us\b|this\b|join)|cover letter|our (mission|team|company|product)|this (role|position|company|team)/i.test(label);
}

// Choice questions: an answer is only usable if it matches one of the choices
// (bidirectional includes, so "Social Media" matches an answer of "social media platforms")
function answerMatchesOption(answer, options) {
  if (!options?.length) return true;
  const a = String(answer).toLowerCase().trim();
  if (!a) return false;
  return options.some(o => {
    const ol = o.toLowerCase();
    return ol.includes(a) || a.includes(ol);
  });
}

function lookupCachedAnswer(db, label, options) {
  const norm = normalizeQuestion(label);
  if (!norm) return null;

  // 1. Exact match on normalized question
  let row = db.prepare('SELECT * FROM answer_cache WHERE question_norm = ?').get(norm);

  // 2. Fuzzy match: token similarity ≥ 0.65 ("project you are most proud of" ≈ "proudest project")
  if (!row) {
    const tokens = questionTokens(norm);
    let best = null, bestScore = 0;
    for (const r of db.prepare('SELECT * FROM answer_cache').all()) {
      const score = questionSimilarity(tokens, questionTokens(r.question_norm));
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (bestScore >= 0.65) row = best;
  }
  if (!row) return null;

  // A cached TODO_ placeholder is a to-edit stub, not a real answer — never
  // auto-fill it (the row stays for you to hand-edit; once replaced with a real
  // value it becomes reusable here).
  if (/TODO_/i.test(row.answer)) return null;

  // Choice questions: only reuse if the cached answer is actually one of the choices
  if (!answerMatchesOption(row.answer, options)) return null;

  db.prepare('UPDATE answer_cache SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    .run(new Date().toISOString().split('T')[0], row.id);
  return row;
}

function saveAnswerToCache(db, label, answer, source) {
  const norm = normalizeQuestion(label);
  if (!norm || !answer) return;
  const today = new Date().toISOString().split('T')[0];

  // Placeholder answers (TODO_*) are cached so they land in answer_cache as a row
  // you can hand-edit — replace the value and future passes reuse your edit. But
  // a placeholder must never OVERWRITE an existing row (DO NOTHING), or a later
  // pass re-emitting the TODO would clobber a value you just filled in. Real
  // answers still upsert normally, so a genuine answer replaces the placeholder.
  const isPlaceholder = /TODO_/i.test(answer);
  db.prepare(`
    INSERT INTO answer_cache (question_norm, question_raw, answer, source, created_at, last_used_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_norm) DO ${isPlaceholder ? 'NOTHING' : `UPDATE SET
      answer = excluded.answer, source = excluded.source, last_used_at = excluded.last_used_at`}
  `).run(norm, label, answer, isPlaceholder ? 'todo' : source, today, today);
}

// ============================================================================
// Answer resolution: static rules → cache → Gemini (agent + profile) → manual
// ============================================================================
function loadContext() {
  const agentPath = join(ROOT, 'apply-agent.md');
  const profile = existsSync(PATHS.profileContext)
    ? readFileSync(PATHS.profileContext, 'utf-8')
    : existsSync(PATHS.cv) ? readFileSync(PATHS.cv, 'utf-8') : '';
  const style = existsSync(PATHS.responseStyle) ? readFileSync(PATHS.responseStyle, 'utf-8') : '';
  const agent = existsSync(agentPath) ? readFileSync(agentPath, 'utf-8') : '';
  return { profile, style, agent };
}

async function resolveAnswer(field, genAI, ctx, cache) {
  const label = field.label.toLowerCase();

  // 1. Static rules — instant, no LLM. A static answer that isn't one of the field's
  // choices (e.g. "LinkedIn" when the options are career fairs) falls through to
  // Gemini, which sees the choices and picks the closest honest one.
  for (const [pattern, answer] of STATIC_ANSWERS) {
    if (pattern.test(label) && answerMatchesOption(answer, field.options)) {
      return { answer, source: 'static' };
    }
  }

  // 2. Cached answer from a previous application (skip for company-specific questions)
  const companySpecific = isCompanySpecific(field.label, cache.company);
  if (!companySpecific) {
    const hit = lookupCachedAnswer(cache.db, field.label, field.options);
    if (hit) return { answer: hit.answer, source: 'cache' };
  }

  // 3. Gemini with the answer agent + profile + this job's description
  if (genAI && ctx.profile) {
    const optionsStr = field.options?.length
      ? `\n\nAvailable choices: ${field.options.join(', ')}\nAnswer with EXACTLY one of the available choices, copied verbatim. If none is a perfect fit, pick the closest honest one (e.g. found the job on LinkedIn but there's no LinkedIn choice → "Social Media" or "Job Board").`
      : '';

    const geminiPrompt = `## Applicant Profile
${ctx.profile}

## Job Being Applied To
Company: ${cache.company || 'Unknown'}
Role: ${ctx.jobTitle || 'Unknown'}

## Job Description
${ctx.jobDesc || '(not available)'}

## Question to Answer
"${field.label}"${optionsStr}

Output only the answer, nothing else.`;

    const systemInstruction = [ctx.agent, ctx.style].filter(Boolean).join('\n\n---\n\n') || undefined;

    for (const modelName of ANSWER_MODELS) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction,
            generationConfig: { temperature: 0.3 },
          });
          const result = await model.generateContent({ contents: [{ parts: [{ text: geminiPrompt }] }] });
          const answer = result.response.text().trim();
          if (answer && !answerMatchesOption(answer, field.options)) {
            console.log(`  ⚠️  ${modelName} answered "${answer.slice(0, 50)}" — not one of the choices, retrying`);
            continue;
          }
          if (answer) {
            if (!companySpecific) saveAnswerToCache(cache.db, field.label, answer, 'gemini');
            return { answer, source: `gemini (${modelName})` };
          }
          break; // empty response — don't retry this model
        } catch (e) {
          const retryable = e.message?.includes('503') || e.message?.includes('429') || e.message?.includes('high demand');
          if (retryable && attempt < 3) {
            await new Promise(r => setTimeout(r, 2000 * attempt));
            continue;
          }
          console.log(`  ⚠️  Gemini ${modelName} failed: ${e.message.slice(0, 80)}`);
          break;
        }
      }
    }
  }

  // 4. Manual — and remember it for next time
  const choicesHint = field.options?.length ? `\n     Choices: ${field.options.join(' | ')}` : '';
  const answer = await prompt(`\n  📝 "${field.label}"${choicesHint}\n     Answer: `);
  if (answer && !companySpecific) saveAnswerToCache(cache.db, field.label, answer, 'manual');
  return { answer, source: 'manual' };
}

// ============================================================================
// Autocomplete / combobox location fields (e.g. Greenhouse "Location (City)")
//
// These ignore a plain .fill() — the value only commits when you TYPE (to fire
// the async lookup) and then click a suggestion from the dropdown. Returns true
// only if a suggestion was clicked; false lets the caller fall back to plain fill.
// ============================================================================
async function fillAutocompleteLocation(page, sel, answer) {
  const input = page.locator(sel).first();
  // Type the city name only — "San Francisco, CA" / "San Francisco Bay Area" → "San Francisco"
  let query = (answer.split(',')[0] || answer).trim().replace(/\s+bay area$/i, '').trim();
  if (!query) return false;

  const optionSel = [
    '[role="listbox"] [role="option"]',
    'ul.ui-autocomplete li',
    '[id*="location_autocomplete"] li',
    '[class*="autocomplete"] [role="option"]',
    '[class*="dropdown"] [role="option"]',
    '[class*="menu"] li[role="option"]',
    // Lever "Current location": plain divs inside .dropdown-results (no ARIA roles);
    // the value only commits to the hidden selectedLocation input on click
    '.dropdown-container .dropdown-results > *',
  ].join(', ');
  const wanted = query.toLowerCase();

  // Suggestion backends (Greenhouse's geocoder especially) routinely take 4s+ and
  // sometimes drop a request outright — so wait generously and retype once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // A menu left open by the previous field's widget can overlay this input
      // and swallow the click — close it, and center the field in the viewport
      // so floating banners (Simplify's) at the screen edges can't cover it.
      await page.keyboard.press('Escape').catch(() => {});
      await input.evaluate(el => el.scrollIntoView({ block: 'center' })).catch(() => {});
      await input.click();
      await input.fill('');
      await input.pressSequentially(query, { delay: 70 }); // fires keydown/input events fill() skips
    } catch {
      return false;
    }

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const options = page.locator(optionSel);
      const count = await options.count().catch(() => 0);
      // Only consider visible options — dropdown containers keep hidden placeholder
      // nodes in the DOM (e.g. Lever's "No location found" / "Loading" divs)
      let chosen = null;
      let firstVisible = null;
      for (let i = 0; i < count; i++) {
        const opt = options.nth(i);
        if (!(await opt.isVisible().catch(() => false))) continue;
        if (!firstVisible) firstVisible = opt;
        const text = ((await opt.textContent().catch(() => '')) || '').toLowerCase();
        if (text.includes(wanted)) { chosen = opt; break; }
      }
      chosen = chosen || firstVisible;
      if (chosen) {
        await chosen.click().catch(() => {});
        await page.waitForTimeout(300);
        // Trust the widget's state, not the click: a suggestion list re-rendering
        // mid-click detaches the element and the click lands nowhere
        if (await locationCommitted(page, sel)) return true;
      }
      await page.waitForTimeout(300);
    }

    // Selector-independent fallback: when a suggestion is highlighted, the input
    // carries aria-activedescendant (ARIA standard, markup-agnostic) and Enter
    // commits it. No highlight → no Enter, so this can never submit the form.
    if (!(await input.getAttribute('aria-activedescendant').catch(() => null))) {
      await input.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(400);
    }
    if (await input.getAttribute('aria-activedescendant').catch(() => null)) {
      await input.press('Enter').catch(() => {});
      await page.waitForTimeout(300);
      if (await locationCommitted(page, sel)) return true;
    }
  }
  return false; // nothing committed — caller falls back / reports failure
}

// Did the location widget actually take the value? Checks the committed state
// per widget type instead of trusting that a click landed.
async function locationCommitted(page, sel) {
  return await page.locator(sel).first().evaluate(el => {
    // Greenhouse React-Select: committed value renders in a single-value div
    const control = el.closest('[class*="control"], [class*="Control"], .select-shell');
    if (control?.querySelector('[class*="single-value"], [class*="singleValue"]')) return true;
    // Lever: the hidden selectedLocation input only fills when a suggestion is picked
    const leverHidden = document.getElementById('selected-location');
    if (leverHidden) return !!leverHidden.value;
    // Plain autocomplete inputs: the clicked suggestion writes into the input itself
    return !!(el.value || '').trim();
  }).catch(() => false);
}

// On a failed location fill, capture WHY: screenshot + one-line widget state.
// Real-session failures (Simplify overlays, stuck menus) don't reproduce in
// clean browsers — this turns the next one into actionable data.
async function dumpLocationFailure(page, field, sel) {
  try {
    mkdirSync(PATHS.screenshots, { recursive: true });
    const file = join(PATHS.screenshots, `location-fail-${Date.now()}.png`);
    await page.screenshot({ path: file }).catch(() => {});
    const state = await page.locator(sel).first().evaluate(el => {
      const r = el.getBoundingClientRect();
      const cover = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        value: el.value,
        ariaExpanded: el.getAttribute('aria-expanded'),
        activeDescendant: el.getAttribute('aria-activedescendant'),
        menuVisible: [...document.querySelectorAll('[class*="menu"], [role="listbox"]')]
          .some(m => m.offsetParent !== null && m.textContent.trim().length > 0),
        coveredBy: cover && cover !== el && !el.contains(cover) && !cover.contains(el)
          ? cover.tagName + '.' + String(cover.className).substring(0, 40)
          : null,
      };
    }).catch(() => null);
    console.log(`     ↳ location diagnostics: ${JSON.stringify(state)}`);
    console.log(`     ↳ screenshot: ${file}`);
  } catch { /* diagnostics must never break the apply flow */ }
}

// ============================================================================
// React-Select widgets (Greenhouse job-boards custom questions)
// The real select is an input[role="combobox"] inside .select__control; typing
// FILTERS the options, so to enumerate them open the menu with ArrowDown instead.
// ============================================================================
const SELECT_OPTION_SEL = '[role="listbox"] [role="option"], [class*="menu"] [class*="option"]';

async function openSelectMenu(page, sel) {
  const input = page.locator(sel).first();
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 3000 });
  await input.press('ArrowDown').catch(() => {});
  const all = page.locator(SELECT_OPTION_SEL);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    // Visibility filter is load-bearing: hidden widgets keep options in the DOM
    // permanently (intl-tel-input's 244-country list, closed menus) — only the
    // open menu's options are visible.
    const visible = await all.evaluateAll(els =>
      els.map((el, i) => ({ i, vis: el.offsetParent !== null, text: (el.textContent || '').trim() }))
        .filter(o => o.vis)
    ).catch(() => []);
    if (visible.length > 0) {
      return visible.map(o => ({ locator: all.nth(o.i), text: o.text }));
    }
    await page.waitForTimeout(250);
  }
  return [];
}

// "Yes. I built…" must match option "Yes": exact → answer-starts-with-option →
// containment (word-bounded on the option side so "No" can't match inside "not").
function bestOptionIndex(texts, answer) {
  const a = (answer || '').toLowerCase().trim();
  if (!a) return -1;
  const clean = texts.map(t => (t || '').toLowerCase().trim());
  let i = clean.findIndex(t => t && t === a);
  if (i !== -1) return i;
  const firstSentence = a.split(/[.!\n]/)[0].trim();
  i = clean.findIndex(t => t && (a.startsWith(t) || firstSentence === t));
  if (i !== -1) return i;
  return clean.findIndex(t =>
    t && (t.includes(a) || new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(a))
  );
}

async function fillReactSelect(page, sel, answer) {
  try {
    const opts = await openSelectMenu(page, sel);
    if (opts.length) {
      const idx = bestOptionIndex(opts.map(o => o.text), answer);
      if (idx !== -1) {
        await opts[idx].locator.click();
        return true;
      }
    }
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  } catch {
    return false;
  }
}

// Pre-answer harvest: read a React-Select's options so choice questions get
// choice answers ("Yes"/"No") instead of prose — resolveAnswer feeds options to
// Gemini and rejects answers that aren't one of them. Returns null for async or
// searchable selects with long option lists (School etc.): not real choice
// questions, and typing is what loads their options anyway.
async function harvestSelectOptions(page, field) {
  const sel = field.id ? `[id="${field.id}"]` : field.name ? `[name="${field.name}"]` : null;
  if (!sel) return null;
  try {
    const isReactSelect = await page.locator(sel).evaluate(el =>
      !!el.closest('[class*="control"], [class*="Control"]')
    ).catch(() => false);
    if (!isReactSelect) return null;
    const opts = await openSelectMenu(page, sel);
    await page.keyboard.press('Escape').catch(() => {});
    const clean = opts.map(o => o.text).filter(t => t && !/no options|loading/i.test(t));
    if (clean.length === 0 || clean.length > 15) return null;
    return clean;
  } catch {
    return null;
  }
}

// ============================================================================
// Parse an optional-question selection like "1,3" / "2-4" / "a" into 0-based
// indices; empty input = none.
// ============================================================================
function parseQuestionSelection(input, count) {
  const s = (input || '').trim().toLowerCase();
  if (!s) return [];
  if (/^a(ll)?$/.test(s)) return [...Array(count).keys()];
  const picked = new Set();
  for (const part of s.split(/[\s,;]+/)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      for (let i = +range[1]; i <= +range[2]; i++) if (i >= 1 && i <= count) picked.add(i - 1);
    } else if (/^\d+$/.test(part) && +part >= 1 && +part <= count) {
      picked.add(+part - 1);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

// ============================================================================
// Fill a form field
// ============================================================================
async function fillField(page, field, answer) {
  // [id="..."] instead of #id so ids with special CSS chars (colons, brackets) still match
  const sel = field.id ? `[id="${field.id}"]` : field.name ? `[name="${field.name}"]` : null;
  if (!sel && !(field.inputType === 'radio' || field.inputType === 'checkbox')) return false;

  try {
    // Ashby yes/no segmented buttons: click the button whose text matches the answer,
    // scoped to the field's entry container via data-field-path
    if (field.inputType === 'ashby-buttons') {
      if (!field.name) return false;
      const entry = page.locator(`[data-field-path="${field.name}"]`).first();
      const buttons = entry.locator('button[class*="_option_"]');
      const count = await buttons.count();
      const a = answer.trim().toLowerCase();
      for (let i = 0; i < count; i++) {
        const text = ((await buttons.nth(i).textContent()) || '').trim().toLowerCase();
        if (text === a || text.includes(a) || a.includes(text)) {
          await buttons.nth(i).click();
          return true;
        }
      }
      return false;
    }

    if (field.inputType === 'radio' || field.inputType === 'checkbox') {
      // Prefer per-option ids: Ashby survey checkboxes have name="<option label>" per box
      // (no shared group name), so a name lookup can't enumerate the group there
      let options = [];
      const ids = (field.optionIds || []).filter(Boolean);
      if (ids.length) {
        options = (await Promise.all(ids.map(id => page.$(`[id="${id}"]`)))).filter(Boolean);
      }
      if (options.length === 0) {
        if (!field.name) return false;
        options = await page.$$(`[name="${field.name}"]`);
      }

      // "Select all that apply" checkboxes may get a comma-separated answer
      const targets = field.inputType === 'checkbox'
        ? answer.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean)
        : [answer.trim().toLowerCase()];

      // Inputs are often visually hidden behind styled controls — click the label instead
      const clickOption = async (opt, id) => {
        if (await opt.isVisible().catch(() => false)) {
          await opt.click().catch(() => {});
        } else if (id) {
          await page.locator(`label[for="${id}"]`).first().click().catch(() => {});
        } else {
          await opt.evaluate(el => (el.closest('label') || el).click()).catch(() => {});
        }
      };

      let clicked = 0;
      for (const opt of options) {
        const id = await opt.getAttribute('id');
        let labelText = '';
        if (id) {
          labelText = await page.$eval(`label[for="${id}"]`, el => el.textContent?.trim()).catch(() => '');
        }
        if (!labelText) {
          labelText = await opt.evaluate(el => el.closest('label')?.textContent?.trim() || '');
        }
        const lt = labelText.toLowerCase();
        if (lt && targets.some(t => lt.includes(t) || t.includes(lt))) {
          await clickOption(opt, id);
          clicked++;
          if (field.inputType === 'radio') return true;
        }
      }
      if (clicked > 0) return true;

      // Single "check if yes" checkbox (common on Ashby): affirmative answer → check it
      if (field.inputType === 'checkbox' && options.length === 1 && /^(yes|true|i agree|agree|acknowledge)/i.test(answer)) {
        await clickOption(options[0], await options[0].getAttribute('id'));
        return true;
      }
      return false;
    }

    if (field.type === 'select') {
      try {
        if (/San Diego/i.test(answer)) {
          const opts = await page.locator(sel).locator('option').allTextContents();
          const exact = opts.find(o => /San Diego/i.test(o) && /California|UC/i.test(o));
          if (exact) {
            await page.locator(sel).selectOption({ label: exact });
            return true;
          }
        }
        await page.locator(sel).selectOption({ label: answer });
        return true;
      } catch {
        return false;
      }
    }

    if (field.type === 'div' && field.ariaHasPopup) {
      await page.locator(sel).click();
      await page.waitForTimeout(300);
      try {
        await page.locator(`text="${answer}"`).click();
        return true;
      } catch {
        return false;
      }
    }

    // Location/city fields: type + pick from the async suggestion dropdown.
    // Checked before the React-Select branch because Greenhouse renders location
    // as a React-Select too, but its options only load after typing.
    if (/\b(location|city)\b/i.test(field.label || '')) {
      const picked = await fillAutocompleteLocation(page, sel, answer);
      if (picked) return true;
      // no suggestion appeared → fall through to plain fill (plain "City, State" text fields)
    }

    // React-Select style dropdown (Greenhouse job-boards custom questions):
    // open the menu WITHOUT typing (typing filters, and prose filters to zero
    // options), pick the best-matching option. Async selects whose options only
    // load on typing (School etc.) fall back to the type + pick path.
    const isReactSelectInput = await page.locator(sel).evaluate(el =>
      !!el.closest('[class*="control"], [class*="Control"]')
    ).catch(() => false);

    if (isReactSelectInput) {
      if (await fillReactSelect(page, sel, answer)) return true;
      if (await fillAutocompleteLocation(page, sel, answer)) return true;
      if (/\b(location|city)\b/i.test(field.label || '')) {
        await dumpLocationFailure(page, field, sel);
      }
      return false;
    }

    // Other combobox widgets: type + pick a suggestion
    const isCombobox = await page.locator(sel).evaluate(el =>
      el.getAttribute('role') === 'combobox' ||
      el.getAttribute('aria-autocomplete') === 'list' ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.getAttribute('aria-expanded') !== null
    ).catch(() => false);

    if (isCombobox) {
      const picked = await fillAutocompleteLocation(page, sel, answer);
      if (picked) return true;
      // fall through to plain fill
    }

    await page.locator(sel).fill(answer);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Screenshot
// ============================================================================
async function takeScreenshot(page, basename) {
  if (!existsSync(PATHS.screenshots)) mkdirSync(PATHS.screenshots, { recursive: true });
  const filepath = join(PATHS.screenshots, `${basename}.png`);
  await page.screenshot({ path: filepath }).catch(() => {});
  return filepath;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║           Apply Jobs — Stage 3: Site-Aware Apply Pipeline      ║
║   review → prep form → Simplify → Gemini gap-fill → you submit ║
╚════════════════════════════════════════════════════════════════╝
`);

  const db = new Database(PATHS.db);
  initAnswerCache(db);

  let jobs;
  if (targetJobId) {
    jobs = db.prepare('SELECT id, url, company, title, location, description, source, status FROM jobs WHERE id = ?').all(targetJobId);
    if (jobs.length && jobs[0].status !== 'verified') {
      console.log(`⚠️  Job ${targetJobId} has status '${jobs[0].status}' (not verified) — proceeding anyway for testing\n`);
    }
  } else {
    const limitSql = limitJobs > 0 ? ` LIMIT ${limitJobs}` : '';
    jobs = db.prepare(`SELECT id, url, company, title, location, description, source FROM jobs WHERE status = 'verified' ORDER BY id ASC${limitSql}`).all();
  }
  console.log(`📋 ${jobs.length} job(s) in this session${limitJobs > 0 ? ` (limited to ${limitJobs})` : ''}\n`);

  if (jobs.length === 0) {
    console.log(targetJobId
      ? `✨ No job with id ${targetJobId} in the database.`
      : '✨ Nothing to apply to. Run the scan + process stages first.');
    db.close();
    return;
  }

  const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
  if (!genAI) console.log('⚠️  GEMINI_API_KEY not set — unanswered questions will need manual input\n');
  const ctx = loadContext();
  if (!ctx.profile) console.log('⚠️  No profile_context.md or cv.md found — Gemini answers disabled, manual input only\n');

  console.log('🌐 Preparing Chrome...');
  const automationDir = ensureAutomationProfile(chromeProfile);
  await killChrome();
  clearChromeCrashState(automationDir, 'Default');
  await launchChrome(automationDir);
  const { browser, context } = await connectChrome();

  const markApplied = db.prepare("UPDATE jobs SET status = 'applied', applied_at = ? WHERE id = ?");
  const markSkipped = db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = 'manually_skipped' WHERE id = ?");
  const markClosed = db.prepare("UPDATE jobs SET status = 'skipped', skip_reason = 'posting_closed' WHERE id = ?");
  const today = new Date().toISOString().split('T')[0];

  let applied = 0, skipped = 0;
  let quit = false;

  for (let i = 0; i < jobs.length && !quit; i++) {
    const job = jobs[i];
    const site = detectSite(job);

    console.log(`\n${'─'.repeat(64)}`);
    console.log(`[${i + 1}/${jobs.length}] ${job.company} — ${job.title}`);
    console.log(`  🌍 ${job.location || 'Unknown location'}   🏛️  ${site.name}`);
    console.log(`  🔗 ${job.url}`);
    console.log('─'.repeat(64));

    const page = await context.newPage();

    try {
      // 1. Open the job page and let the user decide first
      const resp = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      const deadEarly = await detectDeadPosting(page, resp?.status() || 0);
      if (deadEarly) {
        console.log(`  💀 Posting looks dead (${deadEarly}) — marking closed and moving on`);
        markClosed.run(job.id);
        skipped++;
        await page.close();
        continue;
      }

      const decision = await prompt('\n  [Enter] = apply   [s] = skip   [q] = quit\n  > ');
      if (/^q(uit)?$/i.test(decision)) {
        quit = true;
        await page.close();
        break;
      }
      if (/^s(kip)?$/i.test(decision)) {
        markSkipped.run(job.id);
        console.log('  ⏭️  Skipped (moved to skipped bucket)');
        skipped++;
        await page.close();
        continue;
      }

      // 2. Site-specific prep: make sure the form is on screen for Simplify
      const formReady = await site.prepare(page, job);
      if (!formReady) {
        // The prepare step navigates (e.g. Ashby → /application), which is where
        // dead postings often first reveal themselves ("Job not found")
        const dead = await detectDeadPosting(page);
        if (dead) {
          console.log(`  💀 No form and the posting looks dead (${dead}) — marking closed and moving on`);
          markClosed.run(job.id);
          skipped++;
          await page.close();
          continue;
        }
        console.log('  ⚠️  Could not find an application form on this page.');
        const cont = await prompt('  [Enter] = try Simplify anyway   [s] = skip\n  > ');
        if (/^s(kip)?$/i.test(cont)) {
          markSkipped.run(job.id);
          skipped++;
          await page.close();
          continue;
        }
      }

      await waitForCaptchaIfNeeded(page);

      // 3. Simplify autofill
      await waitForSimplify(page);

      // 4. Collect the questions Simplify couldn't answer (required AND optional)
      console.log('  🔍 Scanning for unanswered questions...');
      const unfilled = await scanUnfilledFields(page, { includeOptional: true });
      // Required questions and demographic survey answers are filled automatically;
      // other optional questions are offered as a pick list below
      const autoFields = unfilled.filter(f => f.required || f.optionalSurvey);
      const optionalFields = unfilled.filter(f => !f.required && !f.optionalSurvey);

      const answerAndFill = async (field) => {
        // Greenhouse React-Select questions expose no options until the menu
        // opens — harvest them so choice questions get choice answers, not prose
        if (!field.options?.length && field.type === 'input') {
          const opts = await harvestSelectOptions(page, field);
          if (opts) field.options = opts;
        }
        const { answer, source } = await resolveAnswer(
          field, genAI,
          { ...ctx, jobDesc: job.description || '', jobTitle: job.title },
          { db, company: job.company }
        );
        const filled = await fillField(page, field, answer);
        console.log(`  ${filled ? '✅' : '⚠️ '} ${field.label} ← ${answer.substring(0, 60)}${answer.length > 60 ? '…' : ''} (${source})`);
        if (!filled) console.log('     ↳ could not fill automatically — set this one in the browser');
      };

      if (autoFields.length === 0) {
        console.log('  ✅ Simplify answered every required question');
      } else {
        console.log(`  📝 ${autoFields.length} required question(s) need answers:`);
        for (const f of autoFields) console.log(`     • ${f.label}`);

        // 5+6. Answer each (static → cache → Gemini → manual) and fill it in
        for (const field of autoFields) await answerAndFill(field);
      }

      if (optionalFields.length > 0) {
        console.log(`\n  📋 ${optionalFields.length} optional question(s) currently blank:`);
        optionalFields.forEach((f, i) => console.log(`     [${i + 1}] ${f.label}`));
      }

      await takeScreenshot(page, `${job.id}-${job.company}`);

      // 7. One combined prompt: optionally answer blank questions, then hand off
      // for the actual submit. Numbers / [a] fill optional questions and re-prompt;
      // Enter / s / q end the job.
      const optionalHint = optionalFields.length > 0
        ? '   [a] = answer all optional   or numbers e.g. "1,3"'
        : '';
      let final;
      for (;;) {
        final = await prompt(
          `\n  Review the form in Chrome and click Submit yourself.\n  [Enter] = I submitted (mark applied)   [s] = skip   [q] = quit${optionalHint}\n  > `
        );
        const picked = optionalFields.length > 0 ? parseQuestionSelection(final, optionalFields.length) : [];
        if (picked.length === 0) break;
        for (const idx of picked) await answerAndFill(optionalFields[idx]);
        await takeScreenshot(page, `${job.id}-${job.company}`);
      }
      if (/^q(uit)?$/i.test(final)) {
        quit = true;
      } else if (/^s(kip)?$/i.test(final)) {
        markSkipped.run(job.id);
        console.log('  ⏭️  Skipped');
        skipped++;
      } else {
        markApplied.run(today, job.id);
        console.log('  🎉 Marked applied');
        applied++;
      }
    } catch (err) {
      console.log(`  ⚠️  Error on this job: ${err.message.substring(0, 100)}`);
      const cont = await prompt('  [Enter] = next job   [q] = quit\n  > ');
      if (/^q(uit)?$/i.test(cont)) quit = true;
    }

    await page.close().catch(() => {});
  }

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`✅ Session done: ${applied} applied, ${skipped} skipped, ${jobs.length - applied - skipped} still in to_apply`);
  console.log('═'.repeat(64) + '\n');

  await browser.close().catch(() => {});
  db.close();
}

main().catch(err => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
