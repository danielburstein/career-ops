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

import { readFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
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
  }
}

if (!reportNum) {
  console.log('Usage: node auto-apply.mjs --report <NUM> [--chrome-profile <name>] [--refresh-profile] [--no-submit]');
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

    return required
      .filter(el => {
        const tag = el.tagName.toLowerCase();
        const type = (el.type || '').toLowerCase();

        if (tag === 'input' && type === 'hidden') return false;
        if (type === 'radio' || type === 'checkbox') return !el.checked;

        // Skip nested required elements (inner search inputs inside dropdown containers)
        if (el.parentElement && el.parentElement.closest('[required], [aria-required="true"]')) {
          return false;
        }

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

        // While el is in scope, fix "Select..." / "Unknown" via parent form group
        if (!cleanLabel || /^(select\.{0,3}|unknown)$/i.test(cleanLabel)) {
          const formGroup = el.closest('[class*="field"], [class*="question"], fieldset, li');
          const fallback = formGroup?.querySelector('label')?.textContent?.trim();
          if (fallback) cleanLabel = fallback.replace(/\n/g, ' ').replace(/\s+/g, ' ');
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
// Resolve answer: static → Gemini → manual
// ============================================================================
async function resolveAnswer(field, genAI) {
  const label = field.label.toLowerCase();

  for (const [pattern, answer] of STATIC_ANSWERS) {
    if (pattern.test(label)) {
      return { answer, source: 'static' };
    }
  }

  if (genAI) {
    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{
          parts: [{
            text: `Answer in 1-5 words: "${label}"\n\nContext: UCSD grad (June 2025), 2 years SWE exp, GPA 3.2\n\nOnly answer:`,
          }],
        }],
      });

      const answer = result.response.text().trim();
      if (answer && answer.length > 0) {
        return { answer, source: 'gemini' };
      }
    } catch (e) {
      // Fall through
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
      await page.selectOption(sel, { label: answer }).catch(() =>
        page.selectOption(sel, { value: answer })
      );
      return true;
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
        const { answer, source } = await resolveAnswer(field, genAI);
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

main().catch(console.error);