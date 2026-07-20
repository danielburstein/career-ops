#!/usr/bin/env node
/**
 * batch-gemini.mjs — Batch evaluator using Google Gemini API
 *
 * Reads all pending - [ ] items from data/pipeline.md, fetches JDs from job boards,
 * evaluates with Gemini, writes reports + TSVs + batch summary.
 *
 * Usage:
 *   node batch-gemini.mjs [OPTIONS]
 *   node batch-gemini.mjs --concurrency 5 --min-score 3.5
 *   node batch-gemini.mjs --dry-run
 *   node batch-gemini.mjs --resume  (skip already-processed)
 *
 * Requires:
 *   GEMINI_API_KEY in .env or environment
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';

// Bootstrap .env
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // optional
}

import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  pipeline: join(ROOT, 'data', 'pipeline.md'),
  shared: join(ROOT, 'modes', '_shared.md'),
  oferta: join(ROOT, 'modes', 'oferta.md'),
  cv: join(ROOT, 'cv.md'),
  profile: join(ROOT, 'modes', '_profile.md'),
  profileYml: join(ROOT, 'config', 'profile.yml'),
  reports: join(ROOT, 'reports'),
  trackerAdditions: join(ROOT, 'batch', 'tracker-additions'),
  batchSummary: join(ROOT, 'batch-summary.md'),
};

// ============================================================================
// Parse CLI args
// ============================================================================
const args = process.argv.slice(2);
let concurrency = 10;
let minScore = 0;
let dryRun = false;
let resume = false;
let modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash'; // gemini-2.0-flash is deprecated

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--concurrency' && args[i + 1]) {
    concurrency = parseInt(args[++i], 10);
  } else if (args[i] === '--min-score' && args[i + 1]) {
    minScore = parseFloat(args[++i]);
  } else if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--resume') {
    resume = true;
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  }
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
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ============================================================================
// Load context files
// ============================================================================
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️  ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

console.log('📂  Loading context files...');
const sharedContext = readFile(PATHS.shared, 'modes/_shared.md');
const ofertaLogic = readFile(PATHS.oferta, 'modes/oferta.md');
const cvContent = readFile(PATHS.cv, 'cv.md');
const profileContent = readFile(PATHS.profile, 'modes/_profile.md');
const profileYml = readFile(PATHS.profileYml, 'config/profile.yml');

// Build system prompt (mirrors gemini-eval.mjs)
const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

═══════════════════════════════════════════════════════
USER ARCHETYPES & NARRATIVE (_profile.md)
═══════════════════════════════════════════════════════
${profileContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. CRITICAL FORMATTING RULE: When generating Markdown tables, use exactly three dashes for the header separator rows (e.g., |---|---|). DO NOT pad the separators with extra dashes to match column width.
4. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ============================================================================
// Parse pipeline
// ============================================================================
console.log('📋 Parsing pipeline...');
const pipelineContent = readFileSync(PATHS.pipeline, 'utf-8');
const pipelineLines = pipelineContent.split('\n');

const pendingOffers = [];
let inPendingSection = false;

for (const line of pipelineLines) {
  if (line.trim() === '## Pending' || line.trim() === '## Pendientes') {
    inPendingSection = true;
    continue;
  }
  if (line.startsWith('## ') && inPendingSection) {
    inPendingSection = false;
    continue;
  }

  if (!inPendingSection || !line.trim().startsWith('- [ ]')) {
    continue;
  }

  const match = line.match(
    /^\s*- \[ \]\s*(?:#(\d+)\s+)?(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*$)/
  );
  if (!match) continue;

  const [, num, url, company, role] = match;
  pendingOffers.push({
    num: num ? num.padStart(3, '0') : null,
    url: url.trim(),
    company: company.trim(),
    role: role.trim(),
  });
}

console.log(`   Found ${pendingOffers.length} pending offers\n`);

if (dryRun) {
  console.log('🔍  DRY RUN — would process:');
  pendingOffers.forEach((o) => {
    console.log(
      `   ${(o.num || '???').padStart(3, '0')} | ${o.company.padEnd(20)} | ${o.role}`
    );
  });
  console.log(`\nTotal: ${pendingOffers.length} offers`);
  process.exit(0);
}

// ============================================================================
// Pre-assign report numbers (avoid race conditions with concurrency)
// ============================================================================
function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return 1;
  const files = readdirSync(PATHS.reports);
  const nums = files
    .filter((f) => /^\d{3}-/.test(f))
    .map((f) => parseInt(f.slice(0, 3), 10))
    .filter((n) => !isNaN(n));
  return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
}

let nextNum = nextReportNumber();
const offers = pendingOffers.map((o) => ({
  ...o,
  reportNum: String(nextNum++).padStart(3, '0'),
}));

// ============================================================================
// JD Fetching via fetch (built-in Node 18+)
// ============================================================================
async function fetchJD(url) {
  try {
    // Timeout after 10 seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return `[Could not fetch JD: HTTP ${response.status}]\n\nURL: ${url}`;
    }

    const html = await response.text();

    // Simple extraction: look for job description in common patterns
    // Remove script tags and extract main content
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/\n\n+/g, '\n')
      .trim();

    // Keep first 3000 chars to stay within token limits
    if (text.length > 3000) {
      text = text.substring(0, 3000) + '\n[... truncated ...]';
    }

    return text || `[Could not extract JD text]\n\nURL: ${url}`;
  } catch (err) {
    return `[Could not fetch JD: ${err.message}]\n\nURL: ${url}`;
  }
}

// ============================================================================
// Evaluate with Gemini
// ============================================================================
async function evaluateOffer(offer) {
  const jdText = await fetchJD(offer.url);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 65536,
    },
  });

  const MAX_RETRIES = 4;
  let delay = 3000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([
        { text: systemPrompt },
        {
          text: `\n\nJOB DESCRIPTION TO EVALUATE:\n\nCompany: ${offer.company}\nRole: ${offer.role}\n\n${jdText}`,
        },
      ]);
      const text = result.response.text();
      if (!text || text.trim().length === 0) {
        console.error(`    Error: Empty response from Gemini for ${offer.company}`);
        return null;
      }
      return text;
    } catch (err) {
      const msg = (err.message || '').split(apiKey).join('[REDACTED]');
      const is503 = msg.includes('503') || msg.includes('Service Unavailable');

      if (is503 && attempt < MAX_RETRIES) {
        console.error(`    ⏳ 503 for ${offer.company}, retrying in ${delay/1000}s (${attempt}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }

      console.error(`    Error: Gemini API failed for ${offer.company}: ${msg}`);
      return null;
    }
  }
}

// ============================================================================
// Parse score summary
// ============================================================================
function parseScoreSummary(evaluationText) {
  const summaryMatch = evaluationText.match(
    /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
  );

  const defaults = {
    company: 'Unknown',
    role: 'Unknown',
    score: '?',
    archetype: 'Unknown',
    legitimacy: 'Unknown',
  };

  if (!summaryMatch) return defaults;

  const block = summaryMatch[1];
  const extract = (key) => {
    const prefix = `${key}:`;
    const lines = block.split('\n');
    for (const line of lines) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(prefix)) {
        return trimmed.slice(prefix.length).trim();
      }
    }
    return defaults[key.toLowerCase()];
  };

  return {
    company: extract('COMPANY'),
    role: extract('ROLE'),
    score: extract('SCORE'),
    archetype: extract('ARCHETYPE'),
    legitimacy: extract('LEGITIMACY'),
  };
}

// ============================================================================
// Save report and tracker entry
// ============================================================================
function saveReport(offer, evaluationText, summary) {
  mkdirSync(PATHS.reports, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const companySlug = offer.company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const filename = `${offer.reportNum}-${companySlug}-${today}.md`;
  const reportPath = join(PATHS.reports, filename);

  // Remove score summary from output (keep it internal)
  const cleanEval = evaluationText
    .replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '')
    .trim();

  const reportContent = `# Evaluation: ${summary.company} — ${summary.role}

**Date:** ${today}
**URL:** ${offer.url}
**Archetype:** ${summary.archetype}
**Score:** ${summary.score}/5
**Legitimacy:** ${summary.legitimacy}
**PDF:** ❌ (pending)
**Tool:** Gemini (${modelName})

---

${cleanEval}
`;

  writeFileSync(reportPath, reportContent, 'utf-8');
  return { filename, reportPath };
}

function saveTrackerEntry(offer, summary) {
  mkdirSync(PATHS.trackerAdditions, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const companySlug = offer.company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const tsvPath = join(
    PATHS.trackerAdditions,
    `${offer.reportNum}-${companySlug}.tsv`
  );

  const tsvContent = `${offer.reportNum}\t${today}\t${offer.company}\t${offer.role}\tEvaluated\t${summary.score}\t❌\t[${offer.reportNum}](reports/${offer.reportNum}-${companySlug}-${today}.md)\tsummary\n`;

  writeFileSync(tsvPath, tsvContent, 'utf-8');
  return tsvPath;
}

// ============================================================================
// Main batch processing
// ============================================================================
console.log(`🤖  Starting Gemini evaluation (concurrency: ${concurrency})...\n`);

const limit = pLimit(concurrency);
const results = [];

const promises = offers.map((offer) =>
  limit(async () => {
    const evaluationText = await evaluateOffer(offer);
    if (!evaluationText) {
      console.log(
        `❌ ${offer.reportNum} | ${offer.company.padEnd(20)} | Failed`
      );
      return null;
    }

    const summary = parseScoreSummary(evaluationText);
    const scoreNum = parseFloat(summary.score);

    // Check min-score gate
    if (!isNaN(scoreNum) && scoreNum < minScore) {
      console.log(
        `⏭️  ${offer.reportNum} | ${offer.company.padEnd(20)} | Score ${summary.score} < ${minScore} (skipped)`
      );
      return null;
    }

    // Save report
    const { filename } = saveReport(offer, evaluationText, summary);

    // Save tracker entry
    saveTrackerEntry(offer, summary);

    console.log(
      `✅ ${offer.reportNum} | ${offer.company.padEnd(20)} | Score ${summary.score}`
    );

    results.push({
      ...offer,
      ...summary,
      filename,
    });

    return results[results.length - 1];
  })
);

await Promise.all(promises);

// ============================================================================
// Generate batch summary
// ============================================================================
console.log('\n📊 Generating batch summary...');

const today = new Date().toISOString().split('T')[0];
let summaryContent = `# Batch Summary — ${today}

| # | Company | Role | Score | Legitimacy | Rec | Report |
|---|---------|------|-------|------------|-----|--------|
`;

const applicableResults = results.filter((r) => r !== null);
applicableResults.sort((a, b) => parseInt(a.reportNum) - parseInt(b.reportNum));

applicableResults.forEach((r) => {
  const scoreNum = parseFloat(r.score);
  const rec = scoreNum >= 4.0 ? 'APPLY' : scoreNum >= 3.5 ? 'MAYBE' : 'SKIP';
  summaryContent += `| ${r.reportNum} | ${r.company} | ${r.role} | ${r.score} | ${r.legitimacy} | ${rec} | [${r.reportNum}](reports/${r.filename}) |\n`;
});

summaryContent += `\n## Action Queue (4.0+)\n`;
const actionQueue = applicableResults.filter((r) => parseFloat(r.score) >= 4.0);
if (actionQueue.length > 0) {
  actionQueue.forEach((r) => {
    summaryContent += `- [ ] ${r.reportNum} ${r.company} — ${r.role} (${r.score})\n`;
  });
} else {
  summaryContent += `(No offers scored 4.0+)\n`;
}

const stats = {
  total: applicableResults.length,
  apply: actionQueue.length,
  maybe: applicableResults.filter((r) => parseFloat(r.score) >= 3.5 && parseFloat(r.score) < 4.0).length,
  skip: applicableResults.filter((r) => parseFloat(r.score) < 3.5).length,
};

summaryContent += `\n## Stats\nEvaluated: ${stats.total} | Apply: ${stats.apply} | Maybe: ${stats.maybe} | Skip: ${stats.skip}\n`;

writeFileSync(PATHS.batchSummary, summaryContent, 'utf-8');

console.log(`✅ Batch summary saved: batch-summary.md\n`);
console.log('━'.repeat(66));
console.log(`Evaluated: ${stats.total} | Apply: ${stats.apply} | Maybe: ${stats.maybe} | Skip: ${stats.skip}`);
console.log('━'.repeat(66));
console.log('\nNext steps:');
console.log('  1. npm run merge              (merge TSVs into tracker)');
console.log('  2. Read batch-summary.md      (review action queue)');
console.log('  3. npm run pdf (for 4.0+ roles)\n');
