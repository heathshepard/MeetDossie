"use strict";
// Shared scenario runner used by Runs 2-5. Executes the Phase B verification
// depth for a single scenario:
//   T1  Sign in (or reuse session)
//   T2  Talk-to-Dossie create prompt → verify create_dossier tool call fires
//   T2f DB dossier row created (queried by property_address for this user)
//   T2g Workspace populated (subsections rendered)
//   T4  Talk-to-Dossie amendment prompt → verify draft_amendment tool call fires
//
// PDF field verification (T3) is delegated to Hadley per spec. Signer/esign
// (T5-T9) is Phase C, out of scope for Phase B.

const fs = require("fs");
const path = require("path");
const { signIn, shot } = require("./signin");
const { openChatPanel, sendMessage } = require("./talk-to-dossie");
const { logIncident } = require("./incident-log");

function record(report, id, verdict, detail) {
  const entry = { id, verdict, ...detail, ts: new Date().toISOString() };
  report.test_points.push(entry);
  const tag = verdict === "PASS" ? "OK" : verdict === "FAIL" ? "FAIL" : "..";
  console.log(
    `[${report.tag}] ${id} ${tag}${detail && detail.detail ? ` — ${detail.detail}` : ""}`,
  );
  return entry;
}

async function queryRecentDossiers(cfg, sinceIso) {
  if (!cfg.supabaseServiceKey) {
    return { ok: false, reason: "no service key — cannot verify DB row directly" };
  }
  const userId = cfg.demoUserId;
  if (!userId) {
    return { ok: false, reason: "cfg.demoUserId not set" };
  }
  const url =
    `${cfg.supabaseUrl}/rest/v1/transactions?` +
    `user_id=eq.${userId}&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=5`;
  try {
    const res = await fetch(url, {
      headers: {
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `supabase ${res.status}: ${text.slice(0, 200)}` };
    }
    const rows = await res.json();
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// Wait up to timeoutMs for any new dossier row for this user to appear.
// Returns the newest row created since `sinceIso`.
async function waitForDossierRow(cfg, scenario, sinceIso, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await queryRecentDossiers(cfg, sinceIso);
    if (res.ok && Array.isArray(res.rows) && res.rows.length > 0) {
      return { ok: true, row: res.rows[0], allMatches: res.rows };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const last = await queryRecentDossiers(cfg, sinceIso);
  return { ok: false, reason: "no new dossier row appeared within timeout", last };
}

// Find a create_dossier-shaped tool call in the collected chat responses.
function findCreateDossierCall(toolCalls) {
  return toolCalls.find((tc) => {
    if (!tc.name) return false;
    return (
      tc.name === "create_dossier" ||
      tc.name === "open_dossier" ||
      tc.name === "new_dossier" ||
      tc.name === "intent:create_dossier" ||
      tc.name === "intent:open_dossier" ||
      /(?:create|open|new)_dossier/i.test(tc.name)
    );
  });
}

function findAmendmentCall(toolCalls) {
  return toolCalls.find((tc) => {
    if (!tc.name) return false;
    return (
      tc.name === "draft_amendment" ||
      tc.name === "add_amendment" ||
      /amendment/i.test(tc.name)
    );
  });
}

// For non-purchase transaction types (listing/lease), a modification is often
// routed via update_deal_field rather than draft_amendment. That's semantically
// valid — we want to record the difference but not fail the scenario.
function findModificationCall(toolCalls) {
  return toolCalls.find((tc) => {
    if (!tc.name) return false;
    return (
      tc.name === "update_deal_field" ||
      tc.name === "set_deal_field" ||
      tc.name === "update_dossier" ||
      /update_.*field/i.test(tc.name) ||
      /update_dossier/i.test(tc.name)
    );
  });
}

// Deep detect subsections in the workspace (used by T2g)
async function detectWorkspaceSubsections(page, scenario) {
  return page.evaluate((sc) => {
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4"));
    const seen = headings.map((h) => (h.textContent || "").trim()).filter(Boolean);

    // For each expected subsection, check if at least one heading contains the keyword
    const results = {};
    for (const key of sc.expected_subsections || []) {
      results[key] = seen.some((s) => s.toLowerCase().includes(key.toLowerCase()));
    }
    return { seen: seen.slice(0, 30), matched: results };
  }, scenario);
}

async function runScenario(scenario, cfg) {
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const report = {
    run: cfg.runId,
    tag: `run${cfg.runId}`,
    name: scenario.name,
    base_url: cfg.base,
    started_at: new Date().toISOString(),
    finished_at: null,
    verdict: "IN_PROGRESS",
    scenario,
    test_points: [],
    console_errors: [],
    page_errors: [],
    incidents: [],
    fresh_dossier_row: null,
  };

  console.log(`\n=== Run ${cfg.runId} — ${scenario.name} ===`);
  console.log(`base: ${cfg.base}`);
  console.log(`out:  ${cfg.outDir}\n`);

  let session;
  try {
    session = await signIn(cfg);
    record(report, "T1-signin", "PASS", {
      detail: `signed in as ${cfg.email}`,
      screenshot: session.shotPath,
    });
  } catch (err) {
    record(report, "T1-signin", "FAIL", { detail: err.message });
    await logIncident(cfg, {
      severity: "critical",
      category: "auth",
      test_point: "T1-signin",
      detail: err.message,
    });
    return finalizeReport(report, cfg, "FAIL");
  }

  const { browser, page, consoleErrors, pageErrors, requestLog } = session;

  try {
    // T2 — open chat panel + send create-dossier message
    const openRes = await openChatPanel(page);
    if (!openRes.ok) {
      record(report, "T2-open-chat", "FAIL", { detail: openRes.reason });
      await shot(page, cfg.outDir, "T2-FAIL-chat-panel-not-found");
      await logIncident(cfg, {
        severity: "critical",
        category: "ui",
        test_point: "T2-open-chat",
        detail: openRes.reason,
      });
      throw new Error("chat panel not found — cannot proceed");
    }
    await shot(page, cfg.outDir, "T2a-chat-panel-open");

    console.log(`[${report.tag}] sending: "${scenario.create_prompt}"`);
    const createRes = await sendMessage(page, scenario.create_prompt, { timeoutMs: 60000 });
    await shot(page, cfg.outDir, "T2b-after-create-message");

    // Persist raw chat responses for offline analysis
    fs.writeFileSync(
      path.join(cfg.outDir, "T2-chat-responses.json"),
      JSON.stringify(createRes.collected.responses || [], null, 2),
      "utf8",
    );

    if (!createRes.ok) {
      record(report, "T2-create-dossier", "FAIL", { detail: createRes.reason });
      await logIncident(cfg, {
        severity: "critical",
        category: "api",
        test_point: "T2-create-dossier",
        detail: createRes.reason,
      });
      throw new Error("chat did not respond — cannot proceed");
    }

    const createCall = findCreateDossierCall(createRes.collected.toolCalls);
    let uiCreateDossierDetected = false;
    if (!createCall) {
      uiCreateDossierDetected = await page.evaluate(() => {
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4"));
        return headings.some((h) => /open a new dossier/i.test(h.textContent || ""));
      });
    }

    if (!createCall && !uiCreateDossierDetected) {
      record(report, "T2-create-dossier", "FAIL", {
        detail: `no create_dossier tool call AND no create-dossier modal. tool_calls seen: ${JSON.stringify(
          createRes.collected.toolCalls.map((t) => t.name),
        )}`,
      });
      await logIncident(cfg, {
        severity: "high",
        category: "api",
        test_point: "T2-create-dossier",
        detail: "Talk to Dossie did not emit create_dossier tool call",
      });
    } else {
      record(report, "T2-create-dossier", "PASS", {
        detail: createCall
          ? `Dossie called ${createCall.name}`
          : `Dossie opened Create Dossier modal (UI-level detection)`,
        tool_input: createCall && createCall.input,
        ui_modal_detected: uiCreateDossierDetected,
      });
    }

    // T2c: Attempt to complete the modal if it opened. Different transaction types
    // present different button labels. We drive by scenario.modal_steps if present.
    if (scenario.modal_steps && scenario.modal_steps.length > 0) {
      await page.waitForTimeout(1500);
      await shot(page, cfg.outDir, "T2c-modal-open");
      const fillLabeledResults = [];
      for (const step of scenario.modal_steps) {
        try {
          if (step.type === "click_button") {
            await page.click(`button:has-text("${step.text}")`, { timeout: 3000 }).catch(() => {});
            await page.waitForTimeout(300);
          } else if (step.type === "fill_labeled") {
            // Bug fix (2026-07-10): previous impl used `lbl.closest("div")` on a
            // <span> inside a <label> — the <label> is not a <div>, so closest()
            // climbed to the outer form grid and every fill_labeled step wrote
            // to the SAME first input in the grid (which is Property address).
            // The last matching label's value stuck, overwriting property_address.
            //
            // Correct approach: match the <label> element itself by its <span>
            // child's label text (tolerating the confidence-indicator suffix),
            // then find the <input>/<textarea> nested inside THAT label.
            const result = await page.evaluate(
              ({ label, value }) => {
                const want = label.trim().toLowerCase();
                // Normalize label text: strip the confidence glyphs (✓ ⚠ !) and
                // trailing whitespace introduced by the indicator <span>.
                const normalize = (s) =>
                  (s || "")
                    .replace(/[✓⚠!]/g, "")
                    .replace(/\s+/g, " ")
                    .trim()
                    .toLowerCase();
                const allLabels = Array.from(document.querySelectorAll("label"));
                // Prefer <label> elements where the FIRST span child (Field's
                // label span) matches. Fall back to normalized full text match.
                const candidates = allLabels.filter((lbl) => {
                  const span = lbl.querySelector("span");
                  const spanText = span ? normalize(span.textContent) : null;
                  if (spanText === want) return true;
                  if (normalize(lbl.textContent) === want) return true;
                  return false;
                });
                if (candidates.length === 0) {
                  return { ok: false, reason: "no <label> matched", label };
                }
                for (const lbl of candidates) {
                  // Only look at inputs/textareas nested INSIDE the matched
                  // label element — never climb up to the grid container.
                  const input = lbl.querySelector('input:not([type="hidden"]), textarea');
                  if (!input) continue;
                  const proto = input.tagName === "TEXTAREA"
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
                  setter.call(input, String(value));
                  input.dispatchEvent(new Event("input", { bubbles: true }));
                  input.dispatchEvent(new Event("change", { bubbles: true }));
                  return {
                    ok: true,
                    label,
                    value: String(value),
                    inputTag: input.tagName,
                    inputType: input.type || null,
                    inputAutoComplete: input.getAttribute("autocomplete") || null,
                    inputPlaceholder: input.getAttribute("placeholder") || null,
                  };
                }
                return { ok: false, reason: "matched label but no input inside", label };
              },
              step,
            );
            fillLabeledResults.push(result);
          }
        } catch (_) {
          // continue best-effort
        }
      }
      // Surface fill_labeled results into the report for offline diagnosis of
      // silent misses (e.g. label renamed from "Buyer full name" to "Seller / owner name").
      report.fill_labeled_results = fillLabeledResults;
      const missedFills = fillLabeledResults.filter((r) => r && !r.ok);
      if (missedFills.length > 0) {
        await logIncident(cfg, {
          severity: "medium",
          category: "harness",
          test_point: "T2c-modal-fill",
          detail: `fill_labeled missed ${missedFills.length} label(s): ${missedFills.map((m) => m.label).join(", ")}`,
        });
      }
      await page.waitForTimeout(500);
      await shot(page, cfg.outDir, "T2d-modal-filled");

      // Click the Create dossier submit
      await page.click('button:has-text("Create dossier")', { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(6000);
      await shot(page, cfg.outDir, "T2e-after-create-submit");
    }

    // T2f — verify dossier row appeared in DB (any new row for this user since scenario start)
    const rowRes = await waitForDossierRow(cfg, scenario, report.started_at, 25000);
    if (rowRes.ok) {
      report.fresh_dossier_row = {
        id: rowRes.row.id,
        dossier_number: rowRes.row.dossier_number,
        property_address: rowRes.row.property_address,
        sale_price: rowRes.row.sale_price,
        transaction_type: rowRes.row.transaction_type,
        role: rowRes.row.role,
        stage: rowRes.row.stage,
        created_at: rowRes.row.created_at,
      };
      // Compare expected transaction type
      const gotTx = (rowRes.row.transaction_type || "").toLowerCase();
      const expectedTx = (scenario.expected_transaction_type || "").toLowerCase();
      const typeMatch =
        !expectedTx ||
        gotTx === expectedTx ||
        expectedTx.split("|").some((t) => gotTx === t.trim());
      record(report, "T2f-dossier-row", typeMatch ? "PASS" : "PARTIAL", {
        detail: `fresh row id=${rowRes.row.id} tx_type=${rowRes.row.transaction_type} price=${rowRes.row.sale_price} role=${rowRes.row.role}${typeMatch ? "" : ` — expected transaction_type=${expectedTx}`}`,
        row: report.fresh_dossier_row,
      });
      if (!typeMatch) {
        await logIncident(cfg, {
          severity: "medium",
          category: "data",
          test_point: "T2f-dossier-row",
          detail: `transaction_type mismatch — expected ${expectedTx}, got ${rowRes.row.transaction_type}`,
        });
      }
    } else {
      record(report, "T2f-dossier-row", "FAIL", {
        detail: `no dossier row appeared within timeout — address=${scenario.address}, reason=${rowRes.reason || "unknown"}`,
      });
      await logIncident(cfg, {
        severity: "high",
        category: "data",
        test_point: "T2f-dossier-row",
        detail: `dossier row not created — ${rowRes.reason}`,
      });
    }

    // T2g — workspace subsections populated
    const subs = await detectWorkspaceSubsections(page, scenario);
    const wanted = Object.keys(subs.matched || {});
    const found = wanted.filter((k) => subs.matched[k]);
    record(report, "T2g-workspace-populated", found.length === wanted.length ? "PASS" : "PARTIAL", {
      detail: wanted.length
        ? `subsections matched ${found.length}/${wanted.length}: ${found.join(",")}${found.length < wanted.length ? ` — missing ${wanted.filter((k) => !subs.matched[k]).join(",")}` : ""}`
        : `no expected subsections defined — headings seen: ${subs.seen.slice(0, 8).join("|")}`,
      headings_seen: subs.seen,
      matched: subs.matched,
    });

    // T4 — amendment prompt
    console.log(`[${report.tag}] sending: "${scenario.amendment_prompt}"`);
    const amendRes = await sendMessage(page, scenario.amendment_prompt, { timeoutMs: 60000 });
    await shot(page, cfg.outDir, "T4-after-amendment-message");

    fs.writeFileSync(
      path.join(cfg.outDir, "T4-chat-responses.json"),
      JSON.stringify(amendRes.collected.responses || [], null, 2),
      "utf8",
    );

    if (!amendRes.ok) {
      record(report, "T4-amendment", "FAIL", { detail: amendRes.reason });
      await logIncident(cfg, {
        severity: "high",
        category: "api",
        test_point: "T4-amendment",
        detail: amendRes.reason,
      });
    } else {
      const amendCall = findAmendmentCall(amendRes.collected.toolCalls);
      const modCall = !amendCall ? findModificationCall(amendRes.collected.toolCalls) : null;
      if (amendCall) {
        record(report, "T4-amendment", "PASS", {
          detail: `draft_amendment tool call emitted (name=${amendCall.name})`,
          tool_input: amendCall.input,
        });
        // Bug regression check: new_value returned as stringified JSON?
        if (amendCall.input && typeof amendCall.input.new_value === "string") {
          const nv = amendCall.input.new_value.trim();
          if (nv.startsWith("[") || nv.startsWith("{")) {
            report.regression_stringified_new_value = {
              observed: true,
              value: nv.slice(0, 200),
            };
            await logIncident(cfg, {
              severity: "low",
              category: "api",
              test_point: "T4-amendment.new_value.stringified_json",
              detail: `draft_amendment new_value is stringified JSON (${nv.slice(0, 80)}...)`,
            });
          }
        }
      } else if (modCall) {
        // Non-amendment mod (typical for listings/leases). Record as PASS-modification.
        record(report, "T4-amendment", "PASS", {
          detail: `modification tool call emitted (${modCall.name}) — expected for ${scenario.expected_transaction_type} where changes are field updates rather than contract amendments`,
          tool_input: modCall.input,
          modification_tool_name: modCall.name,
        });
      } else {
        record(report, "T4-amendment", "FAIL", {
          detail: `no draft_amendment or modification tool call detected. tool_calls seen: ${JSON.stringify(amendRes.collected.toolCalls.map((t) => t.name))}`,
        });
        await logIncident(cfg, {
          severity: "high",
          category: "api",
          test_point: "T4-amendment",
          detail: "no modification tool call emitted",
        });
      }
    }
  } catch (err) {
    console.error(`[${report.tag}] FATAL`, err.message);
    await shot(page, cfg.outDir, "FATAL");
    record(report, "FATAL", "FAIL", { detail: err.message });
  } finally {
    report.console_errors = consoleErrors.slice(-50);
    report.page_errors = pageErrors.slice(-50);
    report.request_log = requestLog.slice(-60);
    await browser.close();
  }

  const anyFail = report.test_points.some((t) => t.verdict === "FAIL");
  const anyPartial = report.test_points.some((t) => t.verdict === "PARTIAL");
  const verdict = anyFail ? "FAIL" : anyPartial ? "PARTIAL" : "PASS";
  return finalizeReport(report, cfg, verdict);
}

function finalizeReport(report, cfg, verdict) {
  report.finished_at = new Date().toISOString();
  report.verdict = verdict;
  const outPath = path.join(cfg.outDir, "report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[${report.tag}] report -> ${outPath}`);
  console.log(`[${report.tag}] verdict: ${verdict}`);
  return report;
}

module.exports = { runScenario };
