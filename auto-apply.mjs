#!/usr/bin/env node
/**
 * auto-apply.mjs — Fully automated job application with Simplify
 *
 * Uses a dedicated non-default user data directory for Chrome remote debugging,
 * which bypasses Chrome's security restriction on --remote-debugging-port.
 *
 * Flow:
 * 1. Copy source profile (Profile 6) to ChromeForAutomation/Default (one-time)
 * 2. Clear crash state
 * 3. Spawn Chrome with --user-data-dir=ChromeForAutomation
 * 4. Connect via CDP, navigate to job URL
 * 5. Wait for Simplify to auto-fill
 * 6. Fill remaining required fields
 * 7. Screenshot and confirm before submit
 *
 * Usage:
 *   node auto-apply.mjs --report 031
 *   node auto-apply.mjs --report 031 --refresh-profile
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execSync, spawn } from 'child_process';
import { chromium } from 'playwright';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  reports: join(ROOT, 'reports'),
  screenshots: join(ROOT, 'batch', 'apply-screenshots'),
};

const STATIC_ANSWERS = [
  [/know anyone|referral|referred/i, 'No'],
  [/sponsorship|work authorization|visa|citizenship/i, 'No'],
  [/gpa/i, '3.2'],
  [/hybrid|in.?office|on.?site|commit to.*policy/i, 'Yes'],
  [/how did you hear|source|found.*us/i, 'LinkedIn'],
  [/years of.*experience|relevant.*experience/i, '2'],
  [/willing to relocate|relocat/i, 'No'],
];

// CLI
const args = process.argv.slice(2);
let reportNum = null;
let chromeProfile = 'Profile 6';
let noSubmit = false;
let refreshProfile = false;
let queueMode = false;
let minScore = 4.4;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--report') {
    reportNum = args[i + 1];
    i++;
  } else if (args[i] === '--chrome-profile') {
    chromeProfile = args[i + 1];
    i++;
  } else if (args[i] === '--no-submit') {
    noSubmit = true;
  } else if (args[i] === '--refresh-profile') {
    refreshProfile = true;
  } else if (args[i] === '--queue') {
    queueMode = true;
  } else if (args[i] === '--min-score') {
    minScore = parseFloat(args[i + 1]);
    i++;
  }
}

if (!queueMode && !reportNum) {
  console.log('Usage: node auto-apply.mjs --report <NUM> [--chrome-profile <name>] [--refresh-profile] [--no-submit]');
  console.log('   or: node auto-apply.mjs --queue [--min-score <NUM>]');
  process.exit(1);
}

const CHROME_EXE =
  os.platform() === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : os.platform() === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome';

const DEBUG_PORT = 9222;

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
// Read report
// ============================================================================
function readReport(reportNum) {
  const files = readdirSync(PATHS.reports).filter(f => f.startsWith(reportNum + '-'));
  if (files.length === 0) throw new Error(`No report found for ${reportNum}`);
  const content = readFileSync(join(PATHS.reports, files[0]), 'utf-8');
  return { filename: files[0], content };
}

// ============================================================================
// Get Chrome User Data directory (cross-platform)
// ============================================================================
function getChromePath() {
  const home = os.homedir();
  switch (os.platform()) {
    case 'win32':
      return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    default:
      return path.join(home, '.config', 'google-chrome');
  }
}

// ============================================================================
// Get automation user data directory (non-default path for debugging)
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
// Recursively copy directory
// ============================================================================
function copyDirSync(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      try {
        copyFileSync(srcPath, destPath);
      } catch {
        // Skip locked files (e.g., LevelDB locks) — non-fatal
      }
    }
  }
}

// ============================================================================
// Ensure automation profile exists (copy from source profile)
// ============================================================================
function ensureAutomationProfile(sourceProfile) {
  const srcDir = path.join(getChromePath(), sourceProfile);
  const automationDir = getAutomationDataDir();
  const destProfile = path.join(automationDir, 'Default');

  // If already set up and not refreshing, return
  if (fs.existsSync(destProfile) && !refreshProfile) {
    return automationDir;
  }

  // Delete if refresh requested
  if (refreshProfile && fs.existsSync(destProfile)) {
    console.log('  Refreshing automation profile...');
    fs.rmSync(destProfile, { recursive: true, force: true });
  }

  console.log('  Setting up automation profile (may take 30 seconds)...');
  mkdirSync(destProfile, { recursive: true });

  // Copy source profile
  copyDirSync(srcDir, destProfile);

  // Create minimal Local State
  fs.writeFileSync(
    path.join(automationDir, 'Local State'),
    JSON.stringify({ profile: { last_used: 'Default' } })
  );

  console.log('  ✅ Automation profile ready\n');
  return automationDir;
}

// ============================================================================
// Clear Chrome crash state from Preferences file
// ============================================================================
function clearChromeCrashState(baseDir, profileFolder) {
  const prefsPath = path.join(baseDir, profileFolder, 'Preferences');
  if (!fs.existsSync(prefsPath)) return;

  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    let changed = false;

    if (prefs?.profile) {
      if (prefs.profile.exit_type !== 'Normal') {
        prefs.profile.exit_type = 'Normal';
        changed = true;
      }
      if (prefs.profile.exited_cleanly !== true) {
        prefs.profile.exited_cleanly = true;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(prefsPath, JSON.stringify(prefs));
      console.log('  ✅ Chrome crash state cleared');
    }
  } catch (e) {
    console.log(`  ⚠️  Could not patch Preferences: ${e.message}`);
  }
}

// ============================================================================
// Kill existing Chrome
// ============================================================================
async function killChrome() {
  try {
    if (os.platform() === 'win32') {
      execSync('taskkill /IM chrome.exe /F 2>nul', { stdio: 'ignore' });
    } else {
      execSync('pkill -9 chrome', { stdio: 'ignore' });
    }
  } catch {
    // Not running
  }
  await new Promise(r => setTimeout(r, 2000));
}

// ============================================================================
// Launch Chrome with debugging port via spawn (non-default user data dir)
// ============================================================================
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
// Click Apply button if needed (for Lever, Workday, other portals)
// ============================================================================
async function clickApplyIfNeeded(page) {
  const hasForm = await page.evaluate(() =>
    document.querySelectorAll('[required], [aria-required="true"]').length > 0
  );

  if (hasForm) return; // Form already visible (Greenhouse-style)

  console.log('  🔍 No form found, searching for Apply button...');

  // Combined selector — checked simultaneously, includes Lever-specific classes
  const applySelector = 'a:has-text("Apply"), button:has-text("Apply"), [data-qa="btn-apply"], .postings-btn, .template-btn-submit';
  const btn = page.locator(applySelector).first();

  if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('  🖱️ Clicking Apply button to open form...');
    await btn.click();

    // Smart wait: resolve the instant [required] fields enter the DOM (up to 8s)
    console.log('  ⏳ Waiting for application form to load...');
    await page.waitForFunction(() =>
      document.querySelectorAll('[required], [aria-required="true"]').length > 0,
      { timeout: 8000 }
    ).catch(() => {
      console.log('  ⚠️  Form fields did not appear after clicking Apply.');
    });
    return;
  }

  console.log('  ⚠️  No Apply button found — proceeding anyway');
}

// ============================================================================
// Trigger Simplify autofill via shadow DOM traversal
// ============================================================================
async function triggerSimplifyAutofill(page, maxRetries = 10) {
  console.log('  🔍 Searching for Simplify Autofill button...');

  for (let i = 0; i < maxRetries; i++) {
    const coords = await page.evaluate(() => {
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
      console.log(`  🎯 Found button at (${Math.round(coords.x)}, ${Math.round(coords.y)}), clicking...`);
      await page.mouse.click(coords.x, coords.y);
      console.log('  ✅ Clicked Simplify Autofill button (trusted click)');
      return true;
    }

    await page.waitForTimeout(600);
  }

  console.log('  ⚠️  Could not find Simplify Autofill button after 6 seconds');
  return false;
}

// ============================================================================
// Wait for Simplify to auto-fill
// ============================================================================
async function waitForSimplify(page, timeoutMs = 60000) {
  const clicked = await triggerSimplifyAutofill(page);

  if (!clicked) {
    console.log('  Proceeding without Simplify...');
    return;
  }

  await page.waitForTimeout(2000);

  console.log('  ⏳ Waiting for Simplify to finish filling...');
  const STABLE_REQUIRED = 8;   // 8 × 500ms = 4s — bridges Simplify's API pause
  const deadline = Date.now() + timeoutMs;
  let stableCount = 0;
  let lastSnapshot = '';

  while (Date.now() < deadline) {
    // Primary: look for Simplify's "Autofill complete!" banner in shadow DOM
    const isCompleteBannerVisible = await page.evaluate(() => {
      function searchForText(root, text) {
        for (const el of root.querySelectorAll('*')) {
          if (el.textContent?.includes(text) && el.childElementCount === 0) return true;
          if (el.shadowRoot && searchForText(el.shadowRoot, text)) return true;
        }
        return false;
      }
      return searchForText(document, 'Autofill complete!');
    });

    if (isCompleteBannerVisible) {
      console.log('  ✅ Simplify "Autofill complete!" signal detected.');
      await page.waitForTimeout(1000);
      return;
    }

    // Fallback: DOM stability (catches Simplify updates that change the banner text)
    const snapshot = await page.evaluate(() =>
      [...document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], select, textarea'
      )].map(el => el.value).join('|')
    );

    const hasActualText = snapshot.replace(/\|/g, '').trim().length > 0;

    if (snapshot === lastSnapshot && hasActualText) {
      stableCount++;
      if (stableCount >= STABLE_REQUIRED) {
        console.log('  ✅ Simplify finished filling (DOM stabilized for 4s).');
        return;
      }
    } else {
      stableCount = 0;
      lastSnapshot = snapshot;
    }

    await page.waitForTimeout(500);
  }

  console.log('  ⚠️  Simplify timed out — proceeding with gap-fill');
}

// ============================================================================
// Find label that precedes an element (scan backward in DOM)
// ============================================================================
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
    if (node.tagName === 'LI') break; // don't escape question boundary
    node = node.parentElement;
  }
  return '';
}

// ============================================================================
// Detect CAPTCHA challenges on the page
// ============================================================================
async function waitForCaptchaIfNeeded(page) {
  const hasCaptcha = await page.evaluate(() => !!(
    document.querySelector('iframe[src*="captcha"]') ||
    document.querySelector('iframe[src*="turnstile"]') ||
    document.querySelector('iframe[src*="funcaptcha"]') ||
    document.querySelector('[class*="captcha"]') ||
    document.querySelector('[class*="hcaptcha"]') ||
    document.querySelector('.cf-challenge-running') ||
    document.querySelector('[data-testid*="captcha"]')
  )).catch(() => false);

  if (hasCaptcha) {
    console.log('\n  🔒 CAPTCHA detected! Please solve it in Chrome, then press Enter...');
    await prompt('  > ');
  }
}

// ============================================================================
// Scan for unfilled required fields
// ============================================================================
async function scanUnfilledFields(page) {
  const unfilled = await page.evaluate(() => {
    const required = [...document.querySelectorAll('[required], [aria-required="true"]')];

    function getVisibleValue(el) {
      const tag = el.tagName.toLowerCase();

      if (tag === 'select') return el.value?.trim() || '';
      if (tag === 'textarea') return el.value?.trim() || '';

      if (tag === 'input') {
        if (el.value?.trim()) return el.value.trim();

        // Find React-Select container using closest() — resilient to extra nesting layers
        const valueContainer = el.closest('[class*="ValueContainer"], [class*="value-container"], [class*="control"]');
        if (valueContainer) {
          if (valueContainer.querySelector('[class*="singleValue"], [class*="single-value"], [class*="selectedValue"]')) return 'filled';
          if (valueContainer.querySelector('[class*="placeholder"], [class*="Placeholder"]')) return '';
        }
        return '';
      }

      // Non-input custom components (div/span containers):
      if (el.querySelector('[class*="singleValue"], [class*="single-value"], [class*="selectedValue"]')) return 'filled';
      if (el.querySelector('[class*="placeholder"], [class*="Placeholder"]')) return '';
      const innerInput = el.querySelector('input');
      if (innerInput?.value?.trim()) return innerInput.value.trim();
      const rawText = el.textContent?.replace(/[×✕▾▼]/g, '').trim() || '';
      if (rawText && !/^select\.{0,3}$/i.test(rawText) && rawText.length > 1) return rawText;
      return '';
    }

    // --- Text inputs (non-radio/checkbox)
    const textFields = required
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

        // Lever label traversal — scan backward to find preceding label
        if (!cleanLabel || /^(select\.{0,3}|unknown)$/i.test(cleanLabel) || /^cards\[/.test(cleanLabel)) {
          // Walk up DOM and check previous siblings for labels (prevents mismatch in multi-field cards)
          const preceding = findPrecedingLabel(el);
          if (preceding) cleanLabel = preceding;
        }

        // Catch nested yes/no/true/false labels
        if (/^(yes|no|true|false)$/i.test(cleanLabel)) {
          const formGroup = el.closest('li, [class*="question"], fieldset');
          const overarchingLabel = formGroup?.querySelector('.application-label, legend, .text')?.textContent?.trim();
          if (overarchingLabel) cleanLabel = overarchingLabel.replace(/\n/g, ' ').replace(/\s+/g, ' ');
        }

        // Auto-detect unlabelled native <select> menus on Lever (e.g., University, "How did you hear")
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
        };
      });

    // --- Radio/checkbox grouping
    const radioByName = new Map();
    const checkboxByKey = new Map();

    for (const el of required) {
      const type = (el.type || '').toLowerCase();
      if (type !== 'radio' && type !== 'checkbox') continue;

      const key = el.name ||
        el.closest('fieldset')?.id ||
        el.closest('[role="group"]')?.id ||
        'anon_' + (el.closest('li, [class*="question"]')?.textContent?.slice(0, 30) || String(Math.random()));

      const map = type === 'radio' ? radioByName : checkboxByKey;
      if (!map.has(key)) map.set(key, { elements: [], anyChecked: false, name: el.name || '' });
      const g = map.get(key);
      g.elements.push(el);
      if (el.checked) g.anyChecked = true;
    }

    function getGroupLabel(firstEl) {
      // Use preceding label search to avoid mismatches in multi-field cards
      const preceding = findPrecedingLabel(firstEl);
      if (preceding) return preceding;
      // Fallback to container search
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

    // Radios: always re-scan (Simplify can be wrong)
    const radioFields = [...radioByName.values()].map(g => ({
      label: getGroupLabel(g.elements[0]) || g.name || 'Unknown',
      type: 'input',
      inputType: 'radio',
      id: '',
      name: g.name,
      ariaHasPopup: '',
      options: getOptionLabels(g.elements),
      currentValue: (g.elements.find(e => e.checked) ? getOptionLabels([g.elements.find(e => e.checked)])[0] : ''),
    }));

    // Checkboxes: skip if ANY is checked (Simplify already selected something)
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
        currentValue: '',
      }));

    return [...textFields, ...radioFields, ...checkboxFields];
  });

  // Smart dedup: keep first per label, but upgrade id/name if a later entry has one
  const uniqueUnfilled = [];
  const seenLabels = new Map();

  for (const field of unfilled) {
    if (!seenLabels.has(field.label)) {
      seenLabels.set(field.label, field);
      uniqueUnfilled.push(field);
    } else {
      const existing = seenLabels.get(field.label);
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
// Load context files (profile + style guide)
// ============================================================================
function loadContext() {
  const profilePath = join(ROOT, 'profile_context.md');
  const stylePath = join(ROOT, 'response_style.md');
  return {
    profile: existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '',
    style: existsSync(stylePath) ? readFileSync(stylePath, 'utf-8') : '',
  };
}

// ============================================================================
// Resolve answer: static → Gemini → manual
// ============================================================================
async function resolveAnswer(field, genAI, ctx) {
  const label = field.label.toLowerCase();

  // Static answers (work auth, university, etc. — critical to avoid hallucination)
  const STATIC_PATTERNS = [
    { re: /legally authorized to work|authorized to work in/i, answer: 'Yes' },
    { re: /will you now or in the future require|require.{0,20}sponsorship|need.{0,20}visa/i, answer: 'No' },
    { re: /university|school you are currently attending/i, answer: 'University of California, San Diego' },
  ];
  for (const { re, answer } of STATIC_PATTERNS) {
    if (re.test(label)) {
      return { answer, source: 'static' };
    }
  }

  for (const [pattern, answer] of STATIC_ANSWERS) {
    if (pattern.test(label)) {
      return { answer, source: 'static' };
    }
  }

  if (genAI && ctx.profile && ctx.style) {
    const MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];
    const MAX_RETRIES = 3;

    const optionsStr = field.options?.length
      ? `\n\nAvailable choices: ${field.options.join(', ')}`
      : '';

    const prompt = `## Applicant Profile
${ctx.profile}

## Job Description
${ctx.jobDesc}

## Question to Answer
"${field.label}"${optionsStr}

Output only the answer, nothing else.`;

    for (const modelName of MODELS) {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const model = genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: ctx.style,
            generationConfig: { temperature: 0.3 },
          });

          const result = await model.generateContent({
            contents: [{ parts: [{ text: prompt }] }],
          });

          const answer = result.response.text().trim();
          if (answer && answer.length > 0) {
            return { answer, source: `gemini (${modelName})` };
          }
          break; // got a response but it was empty — don't retry
        } catch (e) {
          const is503 = e.message?.includes('503') || e.message?.includes('high demand');
          if (is503 && attempt < MAX_RETRIES) {
            const delay = 2000 * attempt; // 2s, 4s, 6s
            console.log(`  ⏳ Gemini ${modelName} busy (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          // Non-503 error or exhausted retries — try next model
          console.log(`  ⚠️  Gemini ${modelName} failed: ${e.message.slice(0, 80)}`);
          break;
        }
      }
    }
  }

  const answer = await prompt(`\n  📝 "${field.label}"\n     Answer: `);
  return { answer, source: 'manual' };
}

// ============================================================================
// Fill a form field
// ============================================================================
async function fillField(page, field, answer) {
  const sel = field.id ? `#${field.id}` : field.name ? `[name="${field.name}"]` : null;

  if (!sel) return false;

  try {
    if (field.inputType === 'radio' || field.inputType === 'checkbox') {
      if (!field.name) return false; // Can't target by name — bail cleanly
      const options = await page.$$(`[name="${field.name}"]`);
      for (const opt of options) {
        const id = await opt.getAttribute('id');
        let labelText = '';
        if (id) {
          labelText = await page
            .$eval(`label[for="${id}"]`, el => el.textContent?.trim())
            .catch(() => '');
        }
        if (!labelText) {
          labelText = await opt.evaluate(el => el.closest('label')?.textContent?.trim() || '');
        }
        if (labelText.toLowerCase().includes(answer.toLowerCase())) {
          await opt.click();
          return true;
        }
      }
      return false;
    }

    if (field.type === 'select') {
      try {
        if (/San Diego/i.test(answer)) {
          // Fuzzy match for UCSD — ATS formats it inconsistently
          const opts = await page.locator(sel).locator('option').allTextContents();
          const exact = opts.find(o => /San Diego/i.test(o) && /California|UC/i.test(o));
          if (exact) {
            await page.locator(sel).selectOption({ label: exact });
            return true;
          }
        }
        await page.locator(sel).selectOption({ label: answer });
        return true;
      } catch (e) {
        console.log(`  ⚠️ Failed to select option for ${sel}: ${e.message}`);
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

    // React-Select: detect if this input is inside a control container
    const isReactSelectInput = await page.locator(sel).evaluate(el =>
      !!el.closest('[class*="control"], [class*="Control"]')
    ).catch(() => false);

    if (isReactSelectInput) {
      try {
        console.log(`  🖱️ Opening custom dropdown for: ${sel}`);
        // XPath ancestor traversal → Playwright native click → trusted event
        const controlLocator = page.locator(sel)
          .locator('xpath=ancestor::*[contains(@class, "control") or contains(@class, "Control")][1]');
        await controlLocator.click();
        await page.waitForTimeout(400);

        const options = page.locator('[class*="option"]');
        const count = await options.count();
        for (let i = 0; i < count; i++) {
          const text = await options.nth(i).textContent();
          if (text && text.toLowerCase().includes(answer.toLowerCase())) {
            await options.nth(i).click();
            return true;
          }
        }
        await page.keyboard.press('Escape');
        return false;
      } catch (e) {
        console.log(`  ⚠️ Dropdown interaction failed: ${e.message}`);
        return false;
      }
    }

    await page.locator(sel).fill(answer);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// Take screenshot
// ============================================================================
async function takeScreenshot(page, basename) {
  const dir = PATHS.screenshots;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filepath = join(dir, `${basename}.png`);
  await page.screenshot({ path: filepath });
  return filepath;
}

// ============================================================================
// Queue mode: parse tracker for applications at or above score threshold
// ============================================================================
function parseQueueFromTracker(minScore = 4.4) {
  const trackerPath = join(ROOT, 'data', 'applications.md');
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const queue = [];
  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 8) continue;
    // Table: # | Date | Company | Role | Score | Status | PDF | Report | Notes
    const score = parseFloat(cols[4]);
    const status = cols[5];
    const reportLink = cols[7]; // e.g. [031](reports/031-glean-...)
    const reportNumMatch = reportLink.match(/\[(\d+)\]/);
    if (!isNaN(score) && score >= minScore && status === 'Evaluated' && reportNumMatch) {
      queue.push({
        reportNum: reportNumMatch[1],
        company: cols[2],
        role: cols[3],
        score,
      });
    }
  }
  return queue.sort((a, b) => b.score - a.score);
}

// ============================================================================
// Mark application as applied in tracker
// ============================================================================
function markApplied(reportNum) {
  const trackerPath = join(ROOT, 'data', 'applications.md');
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const updated = lines.map(line => {
    if (!line.startsWith('|')) return line;
    const cols = line.split('|').map(c => c.trim());
    const reportCell = cols.find(c => c.startsWith(`[${reportNum}]`));
    if (reportCell && line.includes('Evaluated')) {
      return line.replace('Evaluated', 'Applied');
    }
    return line;
  });
  writeFileSync(trackerPath, updated.join('\n'), 'utf-8');
}

// ============================================================================
// Process one application: fill form and take screenshot (no submit)
// ============================================================================
async function processOneApplication(page, report, reportNum, genAI, ctx) {
  const urlMatch = report.content.match(/\*\*URL:\*\*\s*(\S+)/);
  if (!urlMatch) throw new Error('No URL in report');

  const url = urlMatch[1];
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await clickApplyIfNeeded(page);
  await waitForCaptchaIfNeeded(page);
  await waitForSimplify(page);

  console.log('🔍 Scanning form...');
  const unfilled = await scanUnfilledFields(page);

  if (unfilled.length > 0) {
    console.log(`⚠️  ${unfilled.length} unfilled required fields:\n`);
    for (const field of unfilled) {
      const { answer, source } = await resolveAnswer(field, genAI, ctx);
      const filled = await fillField(page, field, answer);
      console.log(`  ${filled ? '✅' : '⚠️ '} ${field.label} ← ${answer} (${source})`);
    }
  } else {
    console.log('✅ All fields filled by Simplify');
  }

  const screenshotPath = await takeScreenshot(page, `${reportNum}-final`);
  return { screenshotPath, url };
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('\n📋 Auto-Apply Pipeline\n');

  let report;
  try {
    report = readReport(reportNum);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const urlMatch = report.content.match(/\*\*URL:\*\*\s*(\S+)/);
  if (!urlMatch) {
    console.error('❌ No URL in report');
    process.exit(1);
  }

  const url = urlMatch[1];
  console.log(`📝 Report: ${reportNum}`);
  console.log(`🔗 URL: ${url}\n`);

  const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

  if (!genAI) {
    console.log('⚠️  GEMINI_API_KEY not set — custom questions need manual input\n');
  }

  // Load context for custom question answering
  const ctx = { ...loadContext(), jobDesc: report.content };

  let browser, page;

  try {
    // Setup automation profile
    console.log('🌐 Preparing Chrome...');
    const automationDir = ensureAutomationProfile(chromeProfile);
    await killChrome();
    clearChromeCrashState(automationDir, 'Default');

    // Launch via spawn + connect via CDP
    await launchChrome(automationDir);
    console.log('🔌 Connecting to Chrome...');
    const result = await connectChrome();
    browser = result.browser;
    page = result.page;

    // Navigate to job URL
    console.log(`📄 Opening job form...`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Click Apply button if needed (for Lever, Workday, etc.)
    await clickApplyIfNeeded(page);

    // Wait for Simplify to fill standard fields
    await waitForSimplify(page);

    // Scan for unfilled required fields
    console.log('🔍 Scanning form...');
    const unfilled = await scanUnfilledFields(page);

    if (unfilled.length === 0) {
      console.log('✅ All fields filled by Simplify\n');
    } else {
      console.log(`⚠️  ${unfilled.length} unfilled required fields:\n`);
      for (const field of unfilled) {
        console.log(`  • ${field.label}`);
      }
      console.log('');

      // Fill each unfilled field
      for (const field of unfilled) {
        const { answer, source } = await resolveAnswer(field, genAI, ctx);
        const filled = await fillField(page, field, answer);
        console.log(
          `  ${filled ? '✅' : '⚠️ '} ${field.label} ← ${answer} (${source})`
        );
      }
    }

    // Final screenshot
    const screenshotPath = await takeScreenshot(page, `${reportNum}-final`);
    console.log(`📸 Screenshot: ${screenshotPath}\n`);

    // Confirm before submit
    if (!noSubmit) {
      const confirm = await prompt('Submit application? (y/n): ');
      if (confirm.toLowerCase() === 'y') {
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          console.log('✅ Application submitted');
          await page.waitForTimeout(3000);
        }
      }
    }
  } catch (e) {
    console.error(`\n❌ Error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
    process.exit(0);
  }
}

// ============================================================================
// Queue mode: process multiple applications with user confirmation
// ============================================================================
async function queueMain() {
  const queue = parseQueueFromTracker(minScore);
  if (!queue.length) {
    console.log('✅ No Evaluated applications at or above the score threshold.');
    process.exit(0);
  }

  console.log(`\n📋 Queue: ${queue.length} applications (score ≥ ${minScore})\n`);
  queue.forEach((a, i) =>
    console.log(`  ${i + 1}. [${a.reportNum}] ${a.company} — ${a.role} (${a.score})`)
  );
  console.log('');

  const automationDir = ensureAutomationProfile(chromeProfile);
  await killChrome();
  clearChromeCrashState(automationDir, 'Default');

  await launchChrome(automationDir);
  console.log('🔌 Connecting to Chrome...');
  const { browser } = await connectChrome();

  const genAI = process.env.GEMINI_API_KEY
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

  const ctx = loadContext();
  let applied = 0, skipped = 0;

  for (let i = 0; i < queue.length; i++) {
    const { reportNum, company, role, score } = queue[i];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[${i + 1}/${queue.length}] ${company} — ${role} (${score})`);
    console.log(`${'─'.repeat(60)}\n`);

    let report;
    try {
      report = readReport(reportNum);
    } catch (e) {
      console.log(`  ⚠️  Could not read report ${reportNum}: ${e.message}. Skipping.`);
      skipped++;
      continue;
    }

    const context = browser.contexts()[0];
    const page = await context.newPage();

    try {
      const appCtx = { ...ctx, jobDesc: report.content };
      await processOneApplication(page, report, reportNum, genAI, appCtx);
    } catch (e) {
      console.log(`  ⚠️  Error filling application: ${e.message}. Skipping.`);
      await page.close();
      skipped++;
      continue;
    }

    const decision = await prompt(
      '\n  Review the form in Chrome.\n  [Enter] = manually submitted   [s/submit] = script submits   [skip] = skip\n  > '
    );

    if (/^skip$/i.test(decision.trim())) {
      console.log('  ⏭️  Skipped.');
      await page.close();
      skipped++;
    } else if (/^s(ubmit)?$/i.test(decision.trim())) {
      try {
        const submitLocator = page.locator(
          'button[type="submit"], input[type="submit"], [data-qa="btn-submit"], #submit_app, .template-btn-submit, #application-submit'
        ).first();
        const visible = await submitLocator.isVisible({ timeout: 3000 }).catch(() => false);
        if (visible) {
          await submitLocator.scrollIntoViewIfNeeded();
          await submitLocator.click();
          console.log('  ✅ Submitted by script.');
          await page.waitForTimeout(2000);
        } else {
          console.log('  ⚠️  Submit button not found. Please submit manually and press Enter.');
          await prompt('  > ');
        }
      } catch (e) {
        console.log(`  ⚠️  Click failed: ${e.message.slice(0, 80)}`);
        console.log('  Please submit manually and press Enter when done.');
        await prompt('  > ');
      }
      markApplied(reportNum);
      console.log(`  📝 Marked as Applied in tracker.`);
      await page.close();
      applied++;
    } else {
      markApplied(reportNum);
      console.log(`  📝 Marked as Applied in tracker.`);
      await page.close();
      applied++;
    }
  }

  await browser.close();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ Queue complete: ${applied} applied, ${skipped} skipped`);
  console.log(`${'═'.repeat(60)}\n`);
  process.exit(0);
}

// Dispatch
if (queueMode) {
  queueMain().catch(e => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
} else {
  main().catch(console.error);
}