#!/usr/bin/env node
/**
 * board-scan.mjs — Stage 0: enumerate known companies' job boards via ATS APIs
 *
 * Maintains a `companies` registry in data/jobs.db, seeded from every company
 * slug the pipeline has ever seen (jobs table + portals.yml + optional external
 * lists). For each active company, one board API call lists every open job —
 * no browser, no CAPTCHA, no Google indexing lag. New jobs pass a cheap title
 * filter and land as status 'not_checked' for process-jobs.mjs (stage 2).
 *
 * The registry compounds: each google-scan.mjs run discovers new companies,
 * which this script picks up automatically on its next run.
 *
 * Usage:
 *   node board-scan.mjs [--dry-run] [--no-filter] [--max-new N]
 *                       [--seed <file-or-url>] [--company [source:]slug]
 *     --seed     extract ATS board URLs from any text/markdown/HTML source
 *                (e.g. the SimplifyJobs New-Grad-Positions README) and add them
 *     --company  scan a single board, e.g. --company greenhouse:anthropic
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import { fetchJson, fetchText } from './providers/_http.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  db: join(ROOT, 'data', 'jobs.db'),
  portals: join(ROOT, 'portals.yml'),
};

const FAILURES_BEFORE_DEACTIVATION = 3;

// ============================================================================
// Parse CLI args
// ============================================================================
const args = process.argv.slice(2);
let dryRun = false;
let noFilter = false;
let maxNew = Infinity;
let seedArg = null;
let companyArg = null; // { source: 'greenhouse'|'lever'|'ashby'|null, slug }

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') dryRun = true;
  if (args[i] === '--no-filter') noFilter = true;
  if (args[i] === '--max-new' && args[i + 1]) maxNew = parseInt(args[++i], 10);
  if (args[i] === '--seed' && args[i + 1]) seedArg = args[++i];
  if (args[i] === '--company' && args[i + 1]) {
    const raw = args[++i];
    const m = raw.match(/^(greenhouse|lever|ashby):(.+)$/);
    companyArg = m ? { source: m[1], slug: m[2] } : { source: null, slug: raw };
  }
}

// ============================================================================
// Database initialization
// ============================================================================
function initDatabase() {
  const db = new Database(PATHS.db);
  // jobs DDL — keep in sync with google-scan.mjs initDatabase(); stage 0 runs
  // first in the pipeline, so it must be able to create a fresh DB too.
  // Views are owned by google-scan.mjs (createViews) and not duplicated here.
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
    );

    CREATE TABLE IF NOT EXISTS companies (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                  TEXT NOT NULL,
      source                TEXT NOT NULL CHECK (source IN ('greenhouse','lever','ashby')),
      display_name          TEXT,
      seeded_from           TEXT,
      active                INTEGER NOT NULL DEFAULT 1,
      consecutive_failures  INTEGER NOT NULL DEFAULT 0,
      last_error            TEXT,
      first_seen            TEXT NOT NULL,
      last_scanned          TEXT,
      last_success          TEXT,
      jobs_inserted_total   INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS companies_slug_source
      ON companies (lower(slug), source);
  `);
  return db;
}

// keep in sync with google-scan.mjs getSeenUrls()
function getSeenUrls(db) {
  const rows = db.prepare('SELECT url FROM jobs').all();
  return new Set(rows.map(r => r.url));
}

// ============================================================================
// URL helpers
// ============================================================================
// keep in sync with google-scan.mjs normalizeJobUrl()
function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    let pathname = u.pathname.replace(/\/(?:apply|application)\/?$/, '');
    if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${u.origin}${pathname}`;
  } catch {
    return url.split('#')[0].split('?')[0];
  }
}

// Host-independent job identity. Guards the boards.greenhouse.io vs
// job-boards.greenhouse.io split: the DB holds both hosts (from Google), and a
// board's absolute_url uses whichever the company migrated to — plain URL
// diffing would re-insert the same posting under the other host.
function jobKey(url) {
  let m = url.match(/greenhouse\.io\/(?:v1\/boards\/)?([^\/?#]+)\/jobs\/(\d+)/i);
  if (m) return `gh:${m[1].toLowerCase()}:${m[2]}`;
  m = url.match(/jobs(?:\.eu)?\.lever\.co\/([^\/?#]+)\/([^\/?#]+)/i);
  if (m) return `lv:${m[1].toLowerCase()}:${m[2].toLowerCase()}`;
  m = url.match(/jobs\.ashbyhq\.com\/([^\/?#]+)\/([0-9a-f-]{36})/i);
  if (m) return `as:${decodeURIComponent(m[1]).toLowerCase()}:${m[2].toLowerCase()}`;
  return null;
}

const GREENHOUSE_BOARD_HOSTS = new Set([
  'boards.greenhouse.io', 'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io', 'job-boards.eu.greenhouse.io',
]);

// Some boards point absolute_url at the company's own site with ?gh_jid=123.
// normalizeJobUrl strips queries, which would collapse that whole board into a
// single URL — rebuild the canonical greenhouse-hosted URL instead.
function canonicalGreenhouseUrl(slug, job) {
  try {
    const host = new URL(job.absolute_url).hostname;
    if (GREENHOUSE_BOARD_HOSTS.has(host)) return job.absolute_url;
  } catch {
    // Fall through to rebuild
  }
  return `https://job-boards.greenhouse.io/${slug}/jobs/${job.id}`;
}

// ============================================================================
// Slug extraction / hygiene
// ============================================================================
const ATS_URL_PATTERNS = [
  { source: 'greenhouse', re: /boards-api\.greenhouse\.io\/v1\/boards\/([^\/?#\s"')\]]+)/gi },
  { source: 'greenhouse', re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([^\/?#\s"')\]]+)/gi },
  { source: 'lever', re: /api\.lever\.co\/v0\/postings\/([^\/?#\s"')\]]+)/gi },
  { source: 'lever', re: /jobs(?:\.eu)?\.lever\.co\/([^\/?#\s"')\]]+)/gi },
  { source: 'ashby', re: /api\.ashbyhq\.com\/posting-api\/job-board\/([^\/?#\s"')\]]+)/gi },
  { source: 'ashby', re: /jobs\.ashbyhq\.com\/([^\/?#\s"')\]]+)/gi },
];

function extractBoardSlug(url) {
  if (!url) return null;
  for (const { source, re } of ATS_URL_PATTERNS) {
    const m = new RegExp(re.source, 'i').exec(url);
    if (m) return { source, slug: m[1] };
  }
  return null;
}

// Slugs picked out of URLs are messy: percent-encoding (Blackpoint%20Cyber),
// mixed case dupes (Commure/commure), google-scan's 'unknown' fallback.
const SLUG_DENYLIST = new Set(['unknown', 'next-internal']);

function cleanSlug(raw, source) {
  if (!raw) return null;
  let slug;
  try {
    slug = decodeURIComponent(raw).trim();
  } catch {
    slug = raw.trim();
  }
  if (!slug || SLUG_DENYLIST.has(slug.toLowerCase())) return null;
  // Greenhouse and Lever treat slugs case-insensitively; Ashby org names keep
  // their casing (the unique index still collapses case-dupes).
  if (source !== 'ashby') slug = slug.toLowerCase();
  return slug;
}

// ============================================================================
// Seeding the companies registry
// ============================================================================
function collectSeeds(db) {
  const seeds = new Map(); // key: `${source}:${slug.toLowerCase()}`

  const addSeed = (slug, source, displayName, seededFrom) => {
    const clean = cleanSlug(slug, source);
    if (!clean) return;
    const key = `${source}:${clean.toLowerCase()}`;
    if (!seeds.has(key)) {
      seeds.set(key, { slug: clean, source, displayName: displayName || null, seededFrom });
    }
  };

  // (a) Every company slug the pipeline has ever stored a job for
  for (const row of db.prepare('SELECT DISTINCT company, source FROM jobs').all()) {
    if (['greenhouse', 'lever', 'ashby'].includes(row.source)) {
      addSeed(row.company, row.source, null, 'jobs');
    }
  }

  // (b) portals.yml tracked companies with an ATS careers URL
  try {
    const portals = yaml.load(readFileSync(PATHS.portals, 'utf-8'));
    for (const entry of portals?.tracked_companies || []) {
      if (entry.enabled === false) continue;
      const hit = extractBoardSlug(entry.api || entry.careers_url);
      if (hit) addSeed(hit.slug, hit.source, entry.name, 'portals');
    }
  } catch {
    // No portals.yml (or unparseable) — jobs-table seeds still work
  }

  return seeds;
}

async function collectExternalSeeds(arg) {
  const text = /^https?:\/\//i.test(arg)
    ? await fetchText(arg, { timeoutMs: 30000 })
    : readFileSync(arg, 'utf-8');

  const found = new Map();
  for (const { source, re } of ATS_URL_PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const clean = cleanSlug(m[1], source);
      if (!clean) continue;
      const key = `${source}:${clean.toLowerCase()}`;
      if (!found.has(key)) found.set(key, { slug: clean, source, displayName: null, seededFrom: 'seed' });
    }
  }
  return found;
}

function upsertSeeds(db, seeds, today) {
  const stmt = db.prepare(`
    INSERT INTO companies (slug, source, display_name, seeded_from, first_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  let added = 0;
  for (const s of seeds.values()) {
    if (stmt.run(s.slug, s.source, s.displayName, s.seededFrom, today).changes > 0) added++;
  }
  return added;
}

// ============================================================================
// Description building (mirrors google-scan.mjs fetchJD output shape:
// "Location: ...\n\n" + text, capped at 5000 chars — stage 2 depends on it)
// ============================================================================
// keep in sync with google-scan.mjs stripHtml()
function stripHtml(html) {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/\n\n+/g, '\n')
    .trim();
}

// Greenhouse's board API returns `content` HTML-entity-escaped — decode before
// stripHtml or the description is left as &lt;p&gt; soup. Some boards (e.g.
// Adyen) double-escape, so decode until stable (bounded).
function decodeEntities(s) {
  let out = s || '';
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
    if (next === out) break;
    out = next;
  }
  return out;
}

function buildDescription(locationParts, body) {
  const parts = locationParts.filter(p => p && p !== 'unspecified');
  const header = parts.length ? `Location: ${parts.join(' | ')}\n\n` : '';
  return (header + (body || '').trim()).substring(0, 5000);
}

// ============================================================================
// Board fetchers — one API call lists a company's entire board.
// Each returns [{ title, url, location, description }].
// ============================================================================
async function fetchGreenhouseBoard(slug) {
  // ?content=true includes each job's full description in the single call.
  // Big boards return multi-MB payloads — allow 30s instead of the default 10s.
  const data = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    { redirect: 'error', timeoutMs: 30000 }
  );
  return (data.jobs || []).map(j => ({
    title: j.title || '',
    url: canonicalGreenhouseUrl(slug, j),
    location: j.location?.name || null,
    description: buildDescription([j.location?.name], stripHtml(decodeEntities(j.content))),
  }));
}

async function fetchLeverBoard(slug) {
  const postings = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    { redirect: 'error' }
  );
  if (!Array.isArray(postings)) throw new Error('Lever response is not a postings array');
  // Description recipe mirrors google-scan.mjs fetchJD's Lever branch
  return postings.map(j => {
    const sections = [
      j.text || '',
      j.descriptionPlain || stripHtml(j.description || ''),
      ...(j.lists || []).map(l => `${l.text}\n${stripHtml(l.content)}`),
      j.additionalPlain || stripHtml(j.additional || ''),
    ];
    return {
      title: j.text || '',
      url: j.hostedUrl,
      location: j.categories?.location || null,
      description: buildDescription(
        [j.categories?.location, j.workplaceType],
        sections.filter(Boolean).join('\n')
      ),
    };
  });
}

async function fetchAshbyBoard(slug) {
  const data = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    { redirect: 'error', headers: { Accept: 'application/json' } }
  );
  // Ashby's error shape is a 200 without a jobs array
  if (!Array.isArray(data.jobs)) throw new Error('Ashby response missing jobs array');
  // Description recipe mirrors google-scan.mjs fetchJD's Ashby branch
  return data.jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl,
    location: j.location || null,
    description: buildDescription(
      [j.location, j.isRemote ? 'remote' : null],
      j.descriptionPlain || stripHtml(j.descriptionHtml || '')
    ),
  }));
}

const BOARD_FETCHERS = {
  greenhouse: fetchGreenhouseBoard,
  lever: fetchLeverBoard,
  ashby: fetchAshbyBoard,
};

// ============================================================================
// Pre-insert title filter — the token-budget shield. Full boards are mostly
// non-engineering and senior roles; filtering here keeps them out of stage 2.
// A false negative is cheap (stage 2 re-checks anyway); a false positive costs
// one LLM call. Filtered jobs are NOT inserted at all: url is UNIQUE, so a
// skipped row would freeze the decision forever — a later --no-filter run can
// still pick up whatever is still open.
// ============================================================================
const POSITIVE_TITLE_PATTERNS = [
  /\bsoftware\b/i, /\bengineer(?:ing)?\b/i, /\bdeveloper\b/i, /\bswe\b/i,
  /\bfull[ -]?stack\b/i, /\bback[ -]?end\b/i, /\bfront[ -]?end\b/i,
  /\binfrastructure\b/i, /\bplatform\b/i, /\bsre\b/i, /\bmachine learning\b/i,
];

const NEGATIVE_TITLE_PATTERNS = [
  // Seniority — keep in sync with process-jobs.mjs SENIOR_TITLE_PATTERNS
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
  /\bleader\b/i, // "Engineering Leader" — \blead\b misses the -er form
  // Non-SWE noise that "engineer" alone lets through
  /\bsales\b/i, /\bsolutions?\b/i, /\bsupport\b/i, /\bcustomer\b/i, /\baccount\b/i,
  /\bmarketing\b/i, /\brecruit/i, /\bdesign(?:er)?\b/i, /\bproduct manager\b/i,
  /\bhardware\b/i, /\bmechanical\b/i, /\belectrical\b/i, /\bfield\b/i,
  /\bimplementation\b/i, /\bgtm\b/i, /\bdata cent(?:er|re)\b/i, /\bfinancial\b/i,
];

function passesTitleFilter(title) {
  const t = title || '';
  return POSITIVE_TITLE_PATTERNS.some(p => p.test(t))
    && !NEGATIVE_TITLE_PATTERNS.some(p => p.test(t));
}

// ============================================================================
// Main
// ============================================================================
async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║        ATS Board Scanner — Stage 0: Monitor Known Companies   ║
║  One API call per company board, new jobs saved to database   ║
╚════════════════════════════════════════════════════════════════╝
`);

  const db = initDatabase();
  const today = new Date().toISOString().split('T')[0];

  // --- Seed the registry (compounds with every google-scan discovery) ---
  const seeds = collectSeeds(db);
  if (seedArg) {
    console.log(`🌱 Extracting board URLs from ${seedArg} ...`);
    const external = await collectExternalSeeds(seedArg);
    console.log(`   found ${external.size} board slugs`);
    for (const [key, s] of external) if (!seeds.has(key)) seeds.set(key, s);
  }

  let companies;
  if (dryRun) {
    console.log(`🌱 [dry-run] would seed up to ${seeds.size} companies (existing rows unchanged)`);
    // Merge DB rows with unseeded discoveries so dry-run previews the real scan
    companies = db.prepare('SELECT * FROM companies WHERE active = 1').all();
    const known = new Set(companies.map(c => `${c.source}:${c.slug.toLowerCase()}`));
    for (const [key, s] of seeds) {
      if (!known.has(key)) companies.push({ id: null, slug: s.slug, source: s.source, active: 1, consecutive_failures: 0 });
    }
  } else {
    const added = upsertSeeds(db, seeds, today);
    console.log(`🌱 Registry: ${added} new companies seeded (${seeds.size} candidates)`);
    companies = db.prepare('SELECT * FROM companies WHERE active = 1').all();
  }

  if (companyArg) {
    companies = companies.filter(c =>
      c.slug.toLowerCase() === companyArg.slug.toLowerCase()
      && (!companyArg.source || c.source === companyArg.source)
    );
    if (companies.length === 0) {
      console.error(`❌ No active company matching '${(companyArg.source ? companyArg.source + ':' : '') + companyArg.slug}' in the registry`);
      db.close();
      process.exit(1);
    }
  }

  console.log(`📡 Scanning ${companies.length} company boards${noFilter ? ' (title filter OFF)' : ''}${dryRun ? ' [dry-run]' : ''}\n`);

  // --- Dedup state (URL + host-independent job key) ---
  const seenUrls = getSeenUrls(db);
  const seenKeys = new Set();
  for (const u of seenUrls) {
    const k = jobKey(u);
    if (k) seenKeys.add(k);
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO jobs (url, company, title, description, source, status, first_seen)
    VALUES (?, ?, ?, ?, ?, 'not_checked', ?)
  `);
  const successStmt = db.prepare(`
    UPDATE companies SET last_scanned = ?, last_success = ?, consecutive_failures = 0,
           last_error = NULL, jobs_inserted_total = jobs_inserted_total + ?
    WHERE id = ?
  `);
  const failureStmt = db.prepare(`
    UPDATE companies SET last_scanned = ?, consecutive_failures = consecutive_failures + 1,
           last_error = ?, active = CASE WHEN consecutive_failures + 1 >= ${FAILURES_BEFORE_DEACTIVATION} THEN 0 ELSE active END
    WHERE id = ?
  `);

  const stats = { scanned: 0, failed: 0, deactivated: 0, found: 0, filtered: 0, inserted: 0 };
  let maxNewReached = false;
  const limit = pLimit(4);

  const tasks = companies.map(c =>
    limit(async () => {
      if (maxNewReached) return;
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200)); // politeness jitter

      try {
        const jobs = await BOARD_FETCHERS[c.source](c.slug);
        stats.scanned++;
        stats.found += jobs.length;

        let inserted = 0;
        let filtered = 0;
        for (const job of jobs) {
          if (!job.url || !job.title) continue;
          const url = normalizeJobUrl(job.url);
          const key = jobKey(url);
          if (seenUrls.has(url) || (key && seenKeys.has(key))) continue;
          if (!noFilter && !passesTitleFilter(job.title)) {
            filtered++;
            continue;
          }
          if (stats.inserted >= maxNew) {
            if (!maxNewReached) {
              maxNewReached = true;
              console.log(`\n⚠️  --max-new ${maxNew} reached — stopping further inserts\n`);
            }
            break;
          }
          seenUrls.add(url);
          if (key) seenKeys.add(key);
          if (!dryRun) insertStmt.run(url, c.slug, job.title, job.description, c.source, today);
          inserted++;
          stats.inserted++;
        }
        stats.filtered += filtered;

        if (!dryRun && c.id) successStmt.run(today, today, inserted, c.id);
        if (inserted > 0 || filtered > 0) {
          console.log(`  📥 ${c.source}:${c.slug} → ${dryRun ? 'would insert' : 'inserted'} ${inserted} (${jobs.length} open, ${filtered} filtered)`);
        }
      } catch (err) {
        stats.failed++;
        const msg = (err.message || 'unknown error').substring(0, 200);
        console.log(`  ⚠️  ${c.source}:${c.slug} → ${msg.substring(0, 80)}`);
        // --company mode skips counter writes so test runs don't poison the registry
        if (!dryRun && !companyArg && c.id) {
          failureStmt.run(today, msg, c.id);
          const row = db.prepare('SELECT active, consecutive_failures FROM companies WHERE id = ?').get(c.id);
          if (row && row.active === 0) {
            stats.deactivated++;
            console.log(`     ⛔ deactivated after ${row.consecutive_failures} consecutive failures`);
          }
        }
      }
    })
  );

  await Promise.all(tasks);

  console.log(`
╔════════════════════════════════════════════════════════════════╗
║                      Summary                                  ║
╠════════════════════════════════════════════════════════════════╣
║ Boards scanned:  ${stats.scanned.toString().padStart(4)}                                        ║
║ Boards failed:   ${stats.failed.toString().padStart(4)}  (deactivated: ${stats.deactivated.toString().padStart(3)})                     ║
║ Jobs on boards:  ${stats.found.toString().padStart(4)}                                        ║
║ Title-filtered:  ${stats.filtered.toString().padStart(4)}                                        ║
║ New jobs saved:  ${stats.inserted.toString().padStart(4)}${dryRun ? ' (dry-run: nothing written)         ' : '                                    '}    ║
╚════════════════════════════════════════════════════════════════╝
`);

  if (!dryRun && stats.inserted > 0) {
    console.log(`💡 Run 'node process-jobs.mjs' to evaluate and filter the new jobs.\n`);
  }

  db.close();
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
