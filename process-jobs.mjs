#!/usr/bin/env node
/**
 * process-jobs.mjs — Stage 2: LLM Extraction + Filter
 *
 * Reads jobs with status='not_checked' from DB, extracts experience_years and location
 * via Gemini, and updates status to 'verified' or 'skipped'.
 *
 * Usage:
 *   node process-jobs.mjs
 */

import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  db: join(ROOT, 'data', 'jobs.db'),
};

const BAY_AREA_CITIES = [
  'san francisco', 'sf', 'bay area', 'silicon valley', 'san jose',
  'palo alto', 'mountain view', 'sunnyvale', 'santa clara', 'cupertino',
  'redwood city', 'menlo park', 'burlingame', 'san mateo', 'fremont',
  'oakland', 'berkeley', 'emeryville', 'milpitas', 'campbell',
  'los gatos', 'los altos', 'san ramon', 'walnut creek'
];

// Title-based seniority gate — deterministic and free, runs before the LLM.
// SWE II is kept (fine for early career); III and above are not.
const SENIOR_TITLE_PATTERNS = [
  /\b(?:senior|sr)\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\blead\b/i,
  /\bdirector\b/i,
  /\bvp\b|vice president/i,
  /\bhead of\b/i,
  /\bmanager\b/i,
  /\barchitect\b/i,
  /\b(?:iii|iv|vi?)\b/i, // roman-numeral levels 3+
];

function isSeniorTitle(title) {
  return SENIOR_TITLE_PATTERNS.some(p => p.test(title || ''));
}

function isInTargetLocation(location) {
  if (!location) return true; // null → assume could be remote
  const loc = location.toLowerCase();
  if (loc.includes('unknown')) return true; // couldn't determine — don't reject on missing data
  if (/\bremote\b/i.test(location)) return true;
  return BAY_AREA_CITIES.some(city => loc.includes(city));
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`❌ GEMINI_API_KEY not set`);
  process.exit(1);
}

// Model comes from .env (GEMINI_MODEL); the -latest alias survives Google retiring versioned models
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

let geminiModel = null;
function initGeminiModel() {
  if (!geminiModel) {
    const genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
    });
  }
  return geminiModel;
}

async function extractJobMetadata(url, description) {
  if (!description || description.length < 50) {
    return { experience_years: null, location: 'Unknown' };
  }

  const model = initGeminiModel();
  const prompt = `Extract and return ONLY a JSON object:
{
  "experience_years": <number or null>,
  "location": "<string>"
}
Rules: "0-2 years"→2, "2+ years"→2, "3+ years"→3, "no experience"→0, unclear→null.
Location: first location or "Remote".

Job posting:
${description.substring(0, 4000)}`;

  const MAX_RETRIES = 3;
  let delay = 2000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();

      // Extract JSON with brace counting
      let braceCount = 0, jsonStart = -1, jsonEnd = -1;
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

      const parsed = JSON.parse(text.substring(jsonStart, jsonEnd));
      return {
        experience_years: parsed.experience_years ?? null,
        location: (parsed.location && typeof parsed.location === 'string') ? parsed.location : 'Unknown',
      };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      // All retries failed (bad API key, quota, network) — signal failure so the job stays not_checked
      return { failed: true, error: err.message };
    }
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║           Process Jobs — Stage 2: LLM Filter                  ║
║  Evaluates experience_years and location, marks verified/skip  ║
╚════════════════════════════════════════════════════════════════╝
`);

  const db = new Database(PATHS.db);

  // Find jobs to process
  const jobs = db.prepare("SELECT id, url, company, title, description FROM jobs WHERE status = 'not_checked' LIMIT 1000").all();
  console.log(`\n🤖 Model: ${GEMINI_MODEL}`);
  console.log(`📋 Found ${jobs.length} jobs to process\n`);

  if (jobs.length === 0) {
    console.log(`✨ All done! No jobs pending.`);
    db.close();
    process.exit(0);
  }

  const limit = pLimit(5); // 5 concurrent Gemini calls
  let verifiedCount = 0, skipExpCount = 0, skipLocCount = 0, skipSeniorCount = 0, failedCount = 0;

  const updateStmt = db.prepare(`
    UPDATE jobs
    SET experience_years = ?, location = ?, status = ?, skip_reason = ?, processed_at = ?
    WHERE id = ?
  `);

  const today = new Date().toISOString().split('T')[0];

  const tasks = jobs.map((job, idx) =>
    limit(async () => {
      try {
        // Free title check first — senior roles never reach the LLM
        if (isSeniorTitle(job.title)) {
          updateStmt.run(null, null, 'skipped', 'seniority_title', today, job.id);
          skipSeniorCount++;
          console.log(`  [${idx + 1}/${jobs.length}] ${job.company} → skipped (senior title: "${(job.title || '').substring(0, 40)}")`);
          return;
        }

        const metadata = await extractJobMetadata(job.url, job.description);

        if (metadata.failed) {
          failedCount++;
          console.log(`  ⚠️  [${idx + 1}/${jobs.length}] ${job.company} → LLM failed, stays not_checked (${(metadata.error || '').substring(0, 60)})`);
          return;
        }

        let status, skipReason = null;
        if (metadata.experience_years !== null && metadata.experience_years > 2) {
          status = 'skipped';
          skipReason = 'experience_too_high';
          skipExpCount++;
        } else if (!isInTargetLocation(metadata.location)) {
          status = 'skipped';
          skipReason = 'wrong_location';
          skipLocCount++;
        } else {
          status = 'verified';
          verifiedCount++;
        }

        updateStmt.run(metadata.experience_years, metadata.location, status, skipReason, today, job.id);
        console.log(`  [${idx + 1}/${jobs.length}] ${job.company} → ${status}`);
      } catch (err) {
        console.log(`  ⚠️  [${idx + 1}/${jobs.length}] ERROR ${job.company}: ${err.message.substring(0, 40)}`);
      }
    })
  );

  await Promise.all(tasks);

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                      Summary                                  ║
╠════════════════════════════════════════════════════════════════╣
║ Verified (to apply):  ${verifiedCount.toString().padStart(3)}                                    ║
║ Skipped (sr. title):  ${skipSeniorCount.toString().padStart(3)}                                    ║
║ Skipped (exp > 2yr):  ${skipExpCount.toString().padStart(3)}                                    ║
║ Skipped (wrong loc):  ${skipLocCount.toString().padStart(3)}                                    ║
║ Failed (will retry):  ${failedCount.toString().padStart(3)}                                    ║
╚════════════════════════════════════════════════════════════════╝
`);

  if (failedCount > 0) {
    console.log(`\n⚠️  ${failedCount} jobs failed LLM evaluation and remain not_checked.`);
    console.log(`   Check your GEMINI_API_KEY in .env, then re-run 'npm run process-jobs'.\n`);
  }
  console.log(`\n✨ Processed ${jobs.length} jobs.\n`);
  console.log(`💡 Run 'node apply-jobs.mjs' to start applications.\n`);

  db.close();
}

main().catch(err => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
