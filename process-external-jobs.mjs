// process-external-jobs.mjs
import { readFileSync, existsSync } from 'fs';
import { appendToPipeline, appendToScanHistory, loadSeenUrls, loadSeenCompanyRoles } from './scan.mjs';

const PIPELINE_PATH = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';

async function main() {
  const jobListingsJson = process.argv[2];
  if (!jobListingsJson) {
    console.error('Usage: node process-external-jobs.mjs <JSON_JOB_LISTINGS>');
    process.exit(1);
  }

  let jobListings;
  try {
    jobListings = JSON.parse(jobListingsJson);
    if (!Array.isArray(jobListings)) {
      throw new Error('Input must be a JSON array of job listings.');
    }
  } catch (error) {
    console.error(`Error parsing job listings: ${error.message}`);
    process.exit(1);
  }

  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();
  const newOffers = [];
  const date = new Date().toISOString().slice(0, 10);

  let totalDupes = 0;

  for (const job of jobListings) {
    if (!job.url || !job.title || !job.company) {
      console.warn('Skipping malformed job listing:', job);
      continue;
    }

    if (seenUrls.has(job.url)) {
      totalDupes++;
      continue;
    }
    const key = `${job.company.toLowerCase()}::${job.title.toLowerCase()}`;
    if (seenCompanyRoles.has(key)) {
      totalDupes++;
      continue;
    }

    // Mark as seen to avoid intra-run dupes
    seenUrls.add(job.url);
    seenCompanyRoles.add(key);

    newOffers.push({
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location || 'N/A',
      source: 'Google Search' // Source is now Google Search
    });
  }

  if (newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date, 'added');
    console.log(`Added ${newOffers.length} new offers to pipeline. Total duplicates skipped: ${totalDupes}`);
  } else {
    console.log(`No new offers found. Total duplicates skipped: ${totalDupes}`);
  }
}

if (import.meta.url === new URL(process.argv[1]).href) {
  main().catch(err => {
    console.error('Fatal error in process-external-jobs:', err.message);
    process.exit(1);
  });
}