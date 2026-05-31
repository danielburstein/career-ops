#!/usr/bin/env node
/**
 * batch-summary.mjs — Generate a compact summary of all reports in reports/
 *
 * Reads all .md files in reports/, extracts scores and metadata,
 * generates batch-summary.md for quick Claude review.
 *
 * Usage:
 *   node batch-summary.mjs
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPORTS_PATH = join(ROOT, 'reports');
const SUMMARY_PATH = join(ROOT, 'batch-summary.md');

// ============================================================================
// Parse report files
// ============================================================================
console.log('📂  Scanning reports...');

if (!existsSync(REPORTS_PATH)) {
  console.log('❌ reports/ directory not found');
  process.exit(1);
}

const reportFiles = readdirSync(REPORTS_PATH).filter((f) => f.endsWith('.md'));

if (reportFiles.length === 0) {
  console.log('⚠️  No reports found in reports/');
  process.exit(0);
}

const reports = [];

for (const filename of reportFiles) {
  const content = readFileSync(join(REPORTS_PATH, filename), 'utf-8');

  // Extract metadata from header
  const numMatch = filename.match(/^(\d{3})-/);
  const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})\.md$/);

  const companyMatch = content.match(/^# Evaluation: (.+?) —/m);
  const roleMatch = content.match(/^# Evaluation: .+? — (.+?)$/m);
  const scoreMatch = content.match(/^\*\*Score:\*\* (.+?)\/5/m);
  const legitimacyMatch = content.match(/^\*\*Legitimacy:\*\*\s*(.+?)$/m);

  if (!numMatch || !companyMatch || !roleMatch || !scoreMatch) {
    console.warn(`⚠️  Could not parse ${filename}`);
    continue;
  }

  const score = parseFloat(scoreMatch[1]);
  const legitStr = legitimacyMatch ? legitimacyMatch[1].trim() : 'Unknown';

  reports.push({
    num: numMatch[1],
    filename,
    date: dateMatch ? dateMatch[1] : 'unknown',
    company: companyMatch[1],
    role: roleMatch[1],
    score,
    legitimacy: legitStr,
  });
}

reports.sort((a, b) => parseInt(a.num) - parseInt(b.num));

console.log(`✅ Parsed ${reports.length} reports\n`);

// ============================================================================
// Generate summary
// ============================================================================
const today = new Date().toISOString().split('T')[0];
let summaryContent = `# Batch Summary — ${today}

| # | Company | Role | Score | Legitimacy | Rec | Report |
|---|---------|------|-------|------------|-----|--------|
`;

reports.forEach((r) => {
  const rec = r.score >= 4.0 ? '🟢 APPLY' : r.score >= 3.5 ? '🟡 MAYBE' : '🔴 SKIP';
  const legitShort = r.legitimacy.includes('High')
    ? 'High'
    : r.legitimacy.includes('Caution')
      ? 'Caution'
      : 'Suspicious';
  summaryContent += `| ${r.num} | ${r.company} | ${r.role} | ${r.score.toFixed(1)} | ${legitShort} | ${rec} | [${r.num}](reports/${r.filename}) |\n`;
});

// Action queue
summaryContent += `\n## Action Queue (4.0+)\n`;
const actionQueue = reports.filter((r) => r.score >= 4.0);
if (actionQueue.length > 0) {
  actionQueue.forEach((r) => {
    summaryContent += `- [ ] **${r.num}** — ${r.company} | ${r.role} (${r.score.toFixed(1)}/5)\n`;
  });
} else {
  summaryContent += `(No offers scored 4.0+)\n`;
}

// Stats
const stats = {
  total: reports.length,
  apply: reports.filter((r) => r.score >= 4.0).length,
  maybe: reports.filter((r) => r.score >= 3.5 && r.score < 4.0).length,
  skip: reports.filter((r) => r.score < 3.5).length,
  avgScore: reports.length > 0 ? (reports.reduce((sum, r) => sum + r.score, 0) / reports.length).toFixed(1) : 'N/A',
};

summaryContent += `\n## Stats

| Metric | Count |
|--------|-------|
| Total evaluated | ${stats.total} |
| Apply (4.0+) | ${stats.apply} |
| Maybe (3.5-3.9) | ${stats.maybe} |
| Skip (<3.5) | ${stats.skip} |
| **Average score** | **${stats.avgScore}/5** |

## Next Steps

1. Review the Action Queue above — these are offers worth applying to
2. For each 4.0+ role:
   \`\`\`bash
   npm run pdf -- 006  # Generate ATS-optimized PDF for #006
   \`\`\`
3. Prepare application materials (cover letter, answers) using the report
4. Track applications in data/applications.md

## Claude Session Cost

This batch was evaluated via **Google Gemini API** (not Claude).
- Claude usage: ~2 messages (planning + this summary read)
- Gemini API cost: proportional to report generation (typically $0.01–0.05/job)
- Total batch cost: ~100× cheaper than parallel Claude agents
\n`;

writeFileSync(SUMMARY_PATH, summaryContent, 'utf-8');

console.log('✅ Batch summary saved: batch-summary.md\n');
console.log('━'.repeat(66));
console.log(`Total: ${stats.total} | Apply: ${stats.apply} | Maybe: ${stats.maybe} | Skip: ${stats.skip} | Avg: ${stats.avgScore}/5`);
console.log('━'.repeat(66) + '\n');
