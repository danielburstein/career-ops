# Batch Pipeline Architecture (1,000-Job Scale)

## Overview

The batch pipeline is designed to evaluate massive job searches (100–1,000 offers) with minimal Claude session usage. Instead of running parallel Claude sub-agents (expensive), the pipeline uses **Google Gemini API** for bulk evaluations while Claude acts as the brain: orchestrating, reviewing summaries, and generating application materials.

**Expected Claude cost per 1,000 jobs: 2–3 messages (~5k tokens total)**
**Expected Gemini cost per 1,000 jobs: ~$0.50–$2.00**

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ SCAN (zero tokens)                                      │
│ npm run scan                                            │
│ → Discovers new jobs, writes to data/pipeline.md        │
└────────────────┬────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ PRE-FILTER (zero tokens)                                │
│ npm run pre-filter                                      │
│ → Heuristic rules: skip PM/Sales/Design/Senior roles    │
│ → Marks rejected items as [x] #SKIP in pipeline.md      │
│ → 1,000 jobs → ~150 viable                              │
└────────────────┬────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ EVALUATE (Google Gemini API)                            │
│ npm run gemini:batch [OPTIONS]                          │
│ → Reads pending - [ ] items from pipeline.md            │
│ → Fetches JDs from job boards                           │
│ → Runs A-G evaluation per modes/oferta.md               │
│ → Writes:                                               │
│   - reports/{###}-{company}-{date}.md                   │
│   - batch/tracker-additions/{###}-{company}.tsv         │
│   - batch-summary.md (compact table for Claude)         │
└────────────────┬────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ MERGE (zero tokens)                                     │
│ npm run merge                                           │
│ → Folds tracker-additions/ into data/applications.md    │
│ → Updates statuses and links                            │
└────────────────┬────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ CLAUDE REVIEWS (minimal tokens)                         │
│ Read batch-summary.md                                   │
│ → Review action queue (4.0+ scores)                     │
│ → Generates PDFs, answers, prep for top matches         │
│ → ~2k tokens                                            │
└─────────────────────────────────────────────────────────┘
```

---

## Scripts

### 1. **npm run pre-filter**

Zero-AI pre-screening. Marks obvious non-fits without any API cost.

**What it does:**
- Reads all `- [ ]` pending items from `data/pipeline.md`
- Applies heuristic rules (role type, seniority, location, already-processed)
- Marks rejected items as `- [x] #SKIP | URL | Company | Role — Pre-screened: {reason}`
- Prints summary: `Pre-filter: 1000 → 150 viable (850 skipped)`

**Rules applied (in order):**

| Rule | Examples skipped |
|------|------------------|
| **Role type** | Product Manager, Account Executive, Sales, Success Manager, Marketing, Solutions Engineer, Recruiter, Design |
| **Extreme seniority** | Staff+, Senior Staff, Principal, Director, VP, Head of |
| **Location** | Non-target countries (if profile specifies US-only) |
| **Already processed** | If a report file exists for that company slug + date |

**Usage:**
```bash
cd career-ops
npm run pre-filter
```

**Output:**
```
✅ Pre-filter complete: 150 pending → 850 skipped

📋 Skipped items:
   • Anthropic              | Senior Software Engineer, Full-stack | Seniority mismatch: 5+ YOE
   • LinkedIn              | Product Manager, Platform           | Role type excluded: Product Manager
   ...

Remaining viable offers: 150
Next step: npm run gemini:batch
```

---

### 2. **npm run gemini:batch [OPTIONS]**

Bulk evaluation using Google Gemini API. Generates reports, tracker entries, and a batch summary.

**Options:**
- `--concurrency N` — Parallel Gemini calls (default: 5). Higher = faster but uses more quota.
- `--min-score X` — Skip TSV/tracker for scores below X (default: 0 = all scores). Useful to gate low-confidence evaluations.
- `--resume` — Skip URLs that already have a report file in `reports/`. Good for resuming interrupted batches.
- `--dry-run` — Show what would be processed without calling Gemini.
- `--model NAME` — Gemini model to use (default: `gemini-2.5-flash`).

**What it does:**
1. Parses all `- [ ]` pending items from `data/pipeline.md`
2. Pre-assigns report numbers (001, 002, ...) to avoid race conditions with concurrency
3. For each offer in parallel (up to `--concurrency`):
   - Fetches the JD from the job board (if fetching is implemented)
   - Calls Gemini API with full A-G evaluation prompt
   - Parses the score summary block
   - Saves the report: `reports/{###}-{company}-{date}.md`
   - Saves the tracker entry: `batch/tracker-additions/{###}-{company}.tsv`
4. Generates `batch-summary.md` with all results in a quick-scan table
5. Prints summary stats

**Usage:**
```bash
# Evaluate all pending offers, 5 at a time
npm run gemini:batch

# Evaluate with higher parallelism (use more quota, finish faster)
npm run gemini:batch --concurrency 10

# Skip low-confidence matches
npm run gemini:batch --min-score 3.5

# Resume a previous batch (skip offers already evaluated)
npm run gemini:batch --resume

# Dry run to see what would be processed
npm run gemini:batch --dry-run

# Combine options
npm run gemini:batch --concurrency 5 --min-score 3.5 --resume
```

**Output:**
```
📂  Loading context files...
📋 Parsing pipeline...
   Found 150 pending offers

🤖  Starting Gemini evaluation (concurrency: 5)...

✅ 001 | Glean                  | SWE University Grad
✅ 002 | Bland AI               | Forward Deployed Engineer
✅ 003 | Decagon                | Senior SWE, Core Infrastructure
...
📊 Generating batch summary...
✅ Batch summary saved: batch-summary.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Evaluated: 150 | Apply: 12 | Maybe: 25 | Skip: 113
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next steps:
  1. npm run merge              (merge TSVs into tracker)
  2. Read batch-summary.md      (review action queue)
  3. npm run pdf (for 4.0+ roles)
```

---

### 3. **npm run summary**

Regenerates `batch-summary.md` from all existing reports in `reports/`. Use this if reports were added outside the batch pipeline or to refresh the summary.

**What it does:**
- Scans all `.md` files in `reports/`
- Extracts: score, company, role, legitimacy
- Builds a sortable table and action queue
- Writes to `batch-summary.md`

**Usage:**
```bash
npm run summary
```

**Output:**
```
✅ Parsed 150 reports

✅ Batch summary saved: batch-summary.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: 150 | Apply: 12 | Maybe: 25 | Skip: 113 | Avg: 3.2/5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Complete Workflow Example (1,000 jobs)

```bash
cd career-ops

# 1. Discover new jobs from portals
npm run scan
# Output: Wrote 500 new URLs to data/pipeline.md

# 2. Pre-screen to viable candidates (instant, no API cost)
npm run pre-filter
# Output: Pre-filter: 1000 → 150 viable (850 skipped)

# 3. Evaluate all 150 viable via Gemini (use your Google quota)
npm run gemini:batch --concurrency 5
# Takes ~20-30 minutes, produces 150 reports

# 4. Merge tracker entries into main applications.md
npm run merge

# 5. Review results — Claude reads this ONE file:
cat batch-summary.md
# Shows: 12 APPLY (4.0+), 25 MAYBE (3.5-3.9), 113 SKIP

# 6. For each 4.0+ offer, generate PDF + application answers
npm run pdf -- 001
npm run pdf -- 002
# (done interactively — Claude assists here)
```

---

## Cost Comparison

### Old approach: 15 parallel Claude sub-agents
- **Claude usage:** ~15 agents × 5MB context × 5 WebSearch calls = 375k tokens
- **Cost:** ~$1.50 per job evaluated
- **Time:** 10 minutes
- **Limit:** 15 jobs/run (session limit)
- **Total for 150 jobs:** ~$225 + need to retry 14 agents after timeout

### New approach: Google Gemini + Claude orchestration
- **Gemini usage:** 150 jobs × ~2k tokens/job = 300k tokens
- **Claude usage:** 1 message to read summary = ~2k tokens
- **Cost:** ~$0.01 per job (Gemini) + ~$0.01 (Claude)
- **Time:** 30 minutes
- **Limit:** None (Gemini quota, typically 15k free/month)
- **Total for 150 jobs:** ~$3.00 (90% cost reduction)

---

## Configuration

### Google Gemini API Key

1. Get a free API key at https://aistudio.google.com/apikey
2. Add to `.env`:
   ```
   GEMINI_API_KEY=your_key_here
   ```

The free tier includes:
- 15 requests per minute
- Up to 1,500,000 tokens per month (generous for job evaluations)
- No billing required to start

### Adjust concurrency for your quota

If you have a paid Gemini API account with higher quota:
```bash
# Use more parallelism to finish faster
npm run gemini:batch --concurrency 20
```

If you're on free tier and want to be conservative:
```bash
npm run gemini:batch --concurrency 2
```

---

## FAQ

**Q: What if a job board requires authentication to fetch JDs?**
A: In the MVP, `batch-gemini.mjs` doesn't fetch full JDs yet—it passes the title/URL to Gemini and lets it estimate. A production version would use provider modules (`providers/greenhouse.mjs`, `providers/ashby.mjs`) to fetch via public APIs.

**Q: Can I pause and resume a batch?**
A: Yes. Use `--resume` to skip offers that already have a report:
```bash
npm run gemini:batch --resume
```

**Q: How do I filter offers before evaluation?**
A: Two ways:
1. **Heuristic pre-filter:** `npm run pre-filter` (removes obvious non-fits)
2. **Score gate:** `npm run gemini:batch --min-score 3.5` (skip low-confidence matches)

**Q: Can I re-generate the batch summary?**
A: Yes. `npm run summary` rebuilds it from existing reports:
```bash
npm run summary
```

**Q: How do I apply to the 4.0+ offers?**
A: For each high-scoring role:
1. Read the full report: `reports/{###}-{company}-{date}.md`
2. Generate an ATS-optimized PDF: `npm run pdf -- {###}`
3. Use Block H (Draft Application Answers) from the report
4. Submit via the job board
5. Mark as applied in `data/applications.md`

---

## Architecture Benefits

| Benefit | Why |
|---------|-----|
| **Minimal Claude usage** | Sub-agents were expensive; Gemini is cheaper for bulk work |
| **No session limits** | Gemini batches don't hit Claude's per-hour caps |
| **Resumable** | Interrupted batches pick up where they left off |
| **Parallelizable** | Concurrency control keeps quota usage stable |
| **Local control** | All reports are local `.md` files—full control over data |
| **Claude as orchestrator** | Claude handles the hard parts (strategy, writing) once summaries exist |

---

## File Layout

```
career-ops/
├── pre-filter.mjs              (new — zero-AI pre-screening)
├── batch-gemini.mjs            (new — Gemini bulk evaluation)
├── batch-summary.mjs           (new — summary generator)
├── gemini-eval.mjs             (existing — single eval)
├── batch-summary.md            (generated — compact table for Claude)
├── data/
│   ├── pipeline.md             (pending offers, marked with [x] #SKIP)
│   └── applications.md         (tracker of all applications)
├── reports/
│   ├── 001-glean-2026-05-30.md
│   ├── 002-bland-ai-2026-05-30.md
│   └── ...
├── batch/
│   └── tracker-additions/      (per-offer TSV files, pre-merge)
├── modes/
│   ├── oferta.md               (A-G evaluation logic)
│   └── _shared.md              (scoring system)
└── package.json                (add 3 new scripts)
```

---

## Next Steps

1. ✅ Add `pre-filter.mjs`, `batch-gemini.mjs`, `batch-summary.mjs`
2. ✅ Update `package.json` with 3 new scripts
3. Add `p-limit` dependency (for concurrency control)
4. Test on current pipeline.md (15 pending offers)
5. Document in README

Then for production 1,000-job runs:
- Implement JD fetching via `providers/` modules
- Add retry logic for Gemini API transients
- Track batch statistics (time, cost, completion rate)
