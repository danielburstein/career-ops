#!/usr/bin/env node
/**
 * pre-filter.mjs — Zero-AI heuristic pre-screen for job pipeline
 *
 * Reads pending items from data/pipeline.md and marks obvious non-fits
 * without spending any API tokens. Rules applied:
 * 1. Role type (skip: PM, Sales, Marketing, Design, Recruiter, Solutions Engineer)
 * 2. Extreme seniority (skip: Staff+, Principal, Director, VP, Head of)
 * 3. Location (skip: non-target countries if US-only)
 * 4. Already processed (skip: if report exists in reports/)
 *
 * Usage:
 *   node pre-filter.mjs
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const REPORTS_PATH = join(ROOT, 'reports');

// ============================================================================
// Load profile
// ============================================================================
let profileCountry = 'United States';
try {
  const profileContent = readFileSync(PROFILE_PATH, 'utf-8');
  const profile = yaml.load(profileContent);
  if (profile?.location?.country) {
    profileCountry = profile.location.country;
  }
} catch (err) {
  console.warn(`⚠️  Could not load profile.yml: ${err.message}`);
}

// ============================================================================
// Load existing reports (to detect already-processed URLs)
// ============================================================================
const processedReports = new Set();
if (existsSync(REPORTS_PATH)) {
  const files = readdirSync(REPORTS_PATH);
  files.forEach((f) => {
    const match = f.match(/^(\d{3})-(.+)-(\d{4}-\d{2}-\d{2})\.md$/);
    if (match) {
      // Store company slug for quick lookup
      processedReports.add(match[2]);
    }
  });
}

// ============================================================================
// Skip rules (applied in order)
// ============================================================================

function extractCompanySlug(url) {
  // Extract company name from common job board URLs
  // https://jobs.ashbyhq.com/{company}/... → company
  // https://jobs.lever.co/{company}/... → company
  // https://job-boards.greenhouse.io/{company}/... → company
  const match = url.match(/(?:ashbyhq|lever|greenhouse)\.(?:com|io)\/([^\/]+)/);
  return match ? match[1] : null;
}

function shouldSkipRoleType(roleTitle) {
  const skipPatterns = [
    /product manager/i,
    /account executive/i,
    /sales/i,
    /success manager/i,
    /marketing/i,
    /solutions engineer/i,
    /recruiter/i,
    /designer/i,
    /ux\s+designer/i,
    /product designer/i,
    // Non-technical ops/non-engineering roles
    /mailroom/i,
    /loan originator/i,
    /insurance agent/i,
    /claims advocate/i,
    /fulfillment associate/i,
    /supply chain manager/i,
    /air operations/i,
    /ocean operations/i,
    /freight operations/i,
    /public affairs/i,
    /financial analyst/i,
    /\bfp&a\b/i,
    /legal affairs/i,
    /communications lead/i,
    /illustrator/i,
    /technical trainer/i,
    /service delivery trainer/i,
    /customer acquisition/i,
    /paid media/i,
    /member fulfillment/i,
    /mortgage/i,
    /underwriter/i,
    /compliance officer/i,
    /appraisal/i,
    /post closing/i,
    /retail associate/i,
    /fleet monitoring/i,
  ];
  return skipPatterns.some((p) => p.test(roleTitle));
}

function shouldSkipSeniority(roleTitle) {
  const skipPatterns = [
    /\b(?:senior|sr\.?)\b/i,           // Senior or Sr/Sr. anywhere in title
    /^staff\s+/i,
    /^staff\+/i,
    /^senior\s+staff/i,
    /^principal/i,
    /\blead\b/i,                        // Lead Software Engineer, etc.
    /^director/i,
    /^vp\s+/i,
    /^head\s+of/i,
    // Engineering manager roles require 5+ YOE managing teams
    /engineering manager/i,
    /software engineering manager/i,
    /manager\s+i\s+engineering/i,
    /manager\s+ii\s+engineering/i,
    /senior engineering manager/i,
    /group product manager/i,
    /director of engineering/i,
  ];
  return skipPatterns.some((p) => p.test(roleTitle));
}

function shouldSkipLocation(url) {
  // For now, only skip non-US if target is US
  if (profileCountry !== 'United States') {
    return false; // No location filtering for non-US profiles yet
  }

  const nonUSCountries = [
    'london',
    'dublin',
    'berlin',
    'paris',
    'singapore',
    'tokyo',
    'sydney',
    'toronto',
    'mumbai',
    'uk',
    'england',
    'germany',
    'france',
    'japan',
    'india',
    'canada',
    'australia',
  ];

  const urlLower = url.toLowerCase();
  return nonUSCountries.some((country) => urlLower.includes(country));
}

function shouldSkipLocationInTitle(roleTitle) {
  // Many international roles have location in title e.g. "(Indonesia)", "France", "APAC Lead"
  // Use word boundaries to prevent "india" from matching "indiana"
  if (profileCountry !== 'United States') {
    return false;
  }

  const internationalLocs = [
    'london', 'uk', 'emea', 'apac', 'apj', 'latam', 'canada', 'montreal', 'toronto',
    'australia', 'sydney', 'india', 'mumbai', 'bangalore', 'germany', 'france',
    'paris', 'amsterdam', 'netherlands', 'japan', 'tokyo', 'korea', 'singapore',
    'taiwan', 'hong kong', 'indonesia', 'vietnam', 'thailand', 'brazil', 'mexico',
    'spain', 'italy', 'denmark', 'sweden', 'finland', 'norway', 'czech', 'poland',
    'swiss', 'zurich', 'new zealand', 'china', 'gcc', 'middle east',
    'polish speaker', 'german speaker', 'thai speaking', 'french speaking', 'reykjavik',
  ];
  const regexStr = '\\b(?:' + internationalLocs.join('|') + ')\\b';
  return new RegExp(regexStr, 'i').test(roleTitle);
}

function shouldSkipAlreadyProcessed(url) {
  const slug = extractCompanySlug(url);
  if (!slug) return false;
  return processedReports.has(slug);
}

// ============================================================================
// Main logic
// ============================================================================
console.log('📂  Pre-filtering pipeline...\n');

const pipelineContent = readFileSync(PIPELINE_PATH, 'utf-8');
const lines = pipelineContent.split('\n');

const results = {
  pending: [],
  skipped: [],
};

let inPendingSection = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

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

  // Parse pending line: - [ ] #XXX https://... | Company | Role
  const match = line.match(
    /^\s*- \[ \]\s*(?:#\d+\s+)?(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*$)/
  );
  if (!match) {
    results.pending.push(line);
    continue;
  }

  const [, url, company, role] = match;
  const urlTrimmed = url.trim();
  const roleTrimmed = role.trim();

  // Apply skip rules
  let skipReason = null;

  if (shouldSkipRoleType(roleTrimmed)) {
    skipReason = `Role type excluded: ${roleTrimmed}`;
  } else if (shouldSkipSeniority(roleTrimmed)) {
    skipReason = `Seniority mismatch: ${roleTrimmed} (5+ YOE required)`;
  } else if (shouldSkipLocation(urlTrimmed)) {
    skipReason = 'Location outside target (non-US)';
  } else if (shouldSkipLocationInTitle(roleTrimmed)) {
    skipReason = 'Location in title (non-US): ' + roleTrimmed;
  } else if (shouldSkipAlreadyProcessed(urlTrimmed)) {
    skipReason = 'Already processed';
  }

  if (skipReason) {
    results.skipped.push({
      url: urlTrimmed,
      company: company.trim(),
      role: roleTrimmed,
      reason: skipReason,
    });
  } else {
    results.pending.push({
      url: urlTrimmed,
      company: company.trim(),
      role: roleTrimmed,
      lineIndex: i,
    });
  }
}

// ============================================================================
// Update pipeline.md
// ============================================================================

// Rebuild pipeline content with skipped items moved
const newLines = [...lines];
let preScreenedIndex = -1;

// Find the "Pre-screened" section
for (let i = 0; i < newLines.length; i++) {
  if (newLines[i].trim() === '### Zero-AI pre-screen (run `npm run pre-filter`)') {
    preScreenedIndex = i;
    break;
  }
}

// If no section exists, find "### Senior / Staff level" as insertion point
if (preScreenedIndex === -1) {
  for (let i = 0; i < newLines.length; i++) {
    if (newLines[i].startsWith('### ')) {
      preScreenedIndex = i;
      break;
    }
  }
}

if (preScreenedIndex === -1) {
  preScreenedIndex = newLines.length; // append at end
}

// Remove skipped items from pending section
for (const skipped of results.skipped) {
  for (let i = 0; i < newLines.length; i++) {
    if (
      newLines[i].includes(skipped.url) &&
      newLines[i].startsWith('- [ ]')
    ) {
      newLines[i] = newLines[i].replace('- [ ]', '- [x] #SKIP');
      break;
    }
  }
}

const updatedContent = newLines.join('\n');
writeFileSync(PIPELINE_PATH, updatedContent, 'utf-8');

// ============================================================================
// Print summary
// ============================================================================
console.log(
  `✅ Pre-filter complete: ${results.pending.length} pending → ${results.skipped.length} skipped`
);
console.log('');

if (results.skipped.length > 0) {
  console.log('📋 Skipped items:');
  results.skipped.forEach((item) => {
    console.log(
      `   • ${item.company.padEnd(20)} | ${item.role.padEnd(30)} | ${item.reason}`
    );
  });
  console.log('');
}

console.log(`Remaining viable offers: ${results.pending.length}`);
console.log(`Next step: npm run gemini:batch\n`);
