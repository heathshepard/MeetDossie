// api/_lib/trec-license-lookup.js
//
// Read-only client for TREC's public license-search index. Same Typesense
// host/key already used in production by scripts/sa-realtor-scraper-trec.js
// (search-only key, publicly baked into TREC's own frontend bundle at
// trec.texas.gov/apps/license-search/dist/assets — this is not a scraped
// secret, it's the same request a browser makes on trec.texas.gov).
//
// Used by api/onboarding-extract-profile-defaults.js to cross-check a
// member's self-reported license/brokerage/supervisor fields (extracted
// from an uploaded document) against TREC's live public record, instead of
// silently trusting whatever the PDF says. A stale default (old supervisor,
// expired license, wrong sponsor) is exactly the failure this module exists
// to catch before it becomes every future contract's default.
//
// No caching, no writes, no PII stored — every call is a live read against
// TREC's own public data, same as anyone using trec.texas.gov/license-search.

const TS_HOST = 'https://www.trec.texas.gov/ts';
const TS_KEY = 'HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd';

async function ts(path, params, { retries = 2 } = {}) {
  const u = new URL(TS_HOST + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(u, {
        headers: { 'x-typesense-api-key': TS_KEY },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, 500));
          continue;
        }
        return null;
      }
      return await r.json();
    } catch (_) {
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, 500));
        continue;
      }
      return null;
    }
  }
  return null;
}

// A license number can arrive from an extracted PDF as bare digits
// ("751964") or already suffixed ("751964-SA" / "9014162-BB"). TREC's
// customId field always carries the suffix. Try exact match on what we
// were given, then fall back to a couple of common suffix guesses.
function candidateIds(raw) {
  const cleaned = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return [];
  if (/-[A-Z]{2}$/.test(cleaned)) return [cleaned];
  return [cleaned, `${cleaned}-SA`, `${cleaned}-BB`, `${cleaned}-BC`];
}

// Exact lookup by license number. Returns the TREC document or null.
async function lookupByLicenseNumber(rawLicenseNumber) {
  const candidates = candidateIds(rawLicenseNumber);
  for (const id of candidates) {
    const res = await ts('/collections/licenses/documents/search', {
      q: '*',
      filter_by: `customId:=${id}`,
      per_page: '1',
    });
    const hit = res && Array.isArray(res.hits) && res.hits[0];
    if (hit && hit.document) return hit.document;
  }
  return null;
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Does a TREC document's name plausibly match a person's full name? Loose
// on purpose (nicknames, middle names, suffix punctuation) — this is a
// flag-for-human-review signal, not a hard gate.
function nameLooksLikeMatch(doc, fullName) {
  if (!doc || !fullName) return null; // unknown, not a mismatch
  const target = normalizeName(fullName);
  if (!target) return null;
  const first = normalizeName(doc.firstName);
  const last = normalizeName(doc.lastName);
  if (!first && !last) return null;
  return target.includes(first) && target.includes(last) && first.length > 0 && last.length > 0;
}

// Validate one extracted "person" field (agent, supervising broker, broker)
// against TREC's live record. Returns a status the UI can render directly.
//
// status values:
//   'verified'    — license found, Active, name matches
//   'name_mismatch' — license found but the name on file doesn't match
//   'inactive'    — license found but not Active (expired/inactive/revoked)
//   'not_found'   — no TREC record for that license number at all
//   'skipped'     — no license number was extracted to check
async function validatePerson({ licenseNumber, fullName }) {
  if (!licenseNumber) {
    return { status: 'skipped', trecRecord: null, detail: 'No license number extracted to check.' };
  }
  const doc = await lookupByLicenseNumber(licenseNumber);
  if (!doc) {
    return {
      status: 'not_found',
      trecRecord: null,
      detail: `TREC has no license on file matching "${licenseNumber}". Double-check the number before relying on it.`,
    };
  }
  const active = doc.status && (doc.status.value === 'Active' || doc.renewalInfo?.expirationStatus === 'Active');
  const nameMatch = nameLooksLikeMatch(doc, fullName);
  const trecRecord = {
    customId: doc.customId,
    fullName: doc.fullName || `${doc.firstName || ''} ${doc.lastName || ''}`.trim(),
    type: doc.type ? doc.type.subType : null,
    status: doc.status ? doc.status.value : null,
    organizationName: doc.organizationName || null,
    sponsorLicenseNumber: (doc.sponsoringData && doc.sponsoringData[0] && doc.sponsoringData[0].sponsorLicenseNumber) || null,
  };
  if (!active) {
    return { status: 'inactive', trecRecord, detail: `TREC shows this license (${doc.customId}) as "${trecRecord.status}", not Active.` };
  }
  if (nameMatch === false) {
    return {
      status: 'name_mismatch',
      trecRecord,
      detail: `TREC license ${doc.customId} is registered to "${trecRecord.fullName}", which doesn't match the name on your account. Verify this is the right license number.`,
    };
  }
  return { status: 'verified', trecRecord, detail: `Matches TREC's active record for ${trecRecord.fullName}.` };
}

// The headline check this feature exists for: is the extracted "licensed
// supervisor of sales agent" the agent's REAL current sponsor per TREC, or
// a stale name carried over from an old contract? TREC's own record for
// the agent's license names their current sponsor — that's the ground
// truth, more reliable than re-searching the supervisor's name.
async function validateSupervisorAgainstSponsor({ agentLicenseNumber, extractedSupervisorLicense }) {
  if (!agentLicenseNumber) {
    return { status: 'skipped', detail: 'No agent license number extracted — cannot cross-check supervisor.' };
  }
  const agentDoc = await lookupByLicenseNumber(agentLicenseNumber);
  if (!agentDoc) {
    return { status: 'skipped', detail: `Could not look up agent license ${agentLicenseNumber} on TREC.` };
  }
  const currentSponsor = (agentDoc.sponsoringData && agentDoc.sponsoringData[0] && agentDoc.sponsoringData[0].sponsorLicenseNumber) || null;
  if (!currentSponsor) {
    return { status: 'skipped', detail: 'TREC has no active sponsor on file for this license.' };
  }
  if (!extractedSupervisorLicense) {
    return { status: 'skipped', detail: 'No supervisor license was extracted to compare.', currentSponsorLicenseNumber: currentSponsor };
  }
  const extractedCandidates = candidateIds(extractedSupervisorLicense);
  const matches = extractedCandidates.some((c) => c === currentSponsor.toUpperCase());
  if (matches) {
    return { status: 'verified', currentSponsorLicenseNumber: currentSponsor, detail: 'The extracted supervisor license matches TREC\'s current sponsor record for this agent.' };
  }
  return {
    status: 'mismatch',
    currentSponsorLicenseNumber: currentSponsor,
    detail: `TREC's live record shows this agent's current sponsoring broker license as ${currentSponsor}, not ${extractedSupervisorLicense}. The uploaded document may be out of date — verify before saving as a default.`,
  };
}

module.exports = {
  lookupByLicenseNumber,
  validatePerson,
  validateSupervisorAgainstSponsor,
};
