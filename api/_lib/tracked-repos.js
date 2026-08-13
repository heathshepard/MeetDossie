// api/_lib/tracked-repos.js
//
// Central registry of GitHub repos the Merge Queue infrastructure tracks.
// Added 2026-08-13 (Carter, SV-ENG-MERGE-QUEUE-MULTI-REPO) per Heath:
// "I need to see all merges... across ALL my projects, not just MeetDossie
// ... it's waiting on me."
//
// Consumed by: cron-staging-watcher.js, cron-merge-queue-backfill.js,
// merge-to-main.js, merge-queue-list.js, merge-queue-add.js.
//
// Fields:
//   repo            "owner/name" — exact GitHub slug. VERIFIED against the
//                   live GitHub API 2026-08-13 — do not assume a repo name
//                   matches its local folder name. (heathshepard/Dossie
//                   does NOT exist; the real slug is heathshepard/DossieApp.)
//   label           Human-readable name for the PWA row.
//   staging_branch  Branch polled for new commits, or null if the repo has
//                   no staging tier (Rust: feature branches sit directly off
//                   main, no middle branch). null switches the watcher into
//                   branch-scan mode — see cron-staging-watcher.js.
//   main_branch     Branch merge-to-main.js fast-forwards.
//   qa_gate         'quinn' — a row only counts as "ready" once
//                             quinn_qa_status='pass' on that row. This is a
//                             REAL gate only for MeetDossie today (Quinn
//                             Playwright-drives the MeetDossie staging
//                             preview). DossieApp rows carry the same gate
//                             label but nothing currently sets
//                             quinn_qa_status on them — they will
//                             legitimately sit un-flipped until someone
//                             (Quinn or Heath) actually reviews that specific
//                             commit. That's correct, not a bug.
//                    'none'  — no QA harness exists for this repo at all.
//                             "Ready" = simply unmerged. The UI must show an
//                             honest "no QA gate" label — never fabricate a
//                             Quinn pass that never happened.
//   auto_dispatch_quinn  true only for repos where Quinn's Playwright run
//                    actually exercises the commit in question (i.e. it has
//                    a live staging URL to test). MeetDossie only today —
//                    DossieApp's own staging branch has no deployed preview
//                    of its own (it's built into a bundle that gets copied
//                    into MeetDossie); dispatching Quinn against
//                    meetdossie.com for a DossieApp-only commit would test
//                    the wrong thing.

const TRACKED_REPOS = [
  {
    repo: 'heathshepard/MeetDossie',
    label: 'MeetDossie',
    staging_branch: 'staging',
    main_branch: 'main',
    qa_gate: 'quinn',
    auto_dispatch_quinn: true,
  },
  {
    repo: 'heathshepard/DossieApp',
    label: 'Dossie (source)',
    staging_branch: 'staging',
    main_branch: 'main',
    qa_gate: 'quinn',
    auto_dispatch_quinn: false,
  },
  {
    repo: 'heathshepard/Rust',
    label: 'Rust',
    staging_branch: null,
    main_branch: 'main',
    qa_gate: 'none',
    auto_dispatch_quinn: false,
  },
];

function getRepoConfig(repo) {
  return TRACKED_REPOS.find((r) => r.repo === repo) || null;
}

module.exports = { TRACKED_REPOS, getRepoConfig };
