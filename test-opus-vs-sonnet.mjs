#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TEST_CASES = [
  { id: "fill_forms_1", category: "Form Generation", prompt: "Write a contract for 123 Main St, buyer John Smith, $450k, closing June 15, 7 day option", expectedAction: "fill_forms", severity: "C" },
  { id: "amendment_closedate_1", category: "Amendment Drafting", prompt: "Push the closing date back to July 1st", expectedAction: "draft_amendment", severity: "C" },
  { id: "amendment_option_1", category: "Amendment Drafting", prompt: "Extend the option period by 5 more days", expectedAction: "draft_amendment", severity: "C" },
  { id: "update_field_price_1", category: "Field Updates", prompt: "Update sale price to $475,000", expectedAction: "update_deal_field", severity: "H" },
  { id: "update_field_buyer_1", category: "Field Updates", prompt: "Buyer name is Sarah Martinez", expectedAction: "update_deal_field", severity: "C" },
  { id: "draft_email_1", category: "Email Drafting", prompt: "Draft a welcome email to the buyer", expectedAction: "draft_email", severity: "M" },
  { id: "log_offer_1", category: "Offer Tracking", prompt: "We got an offer for $425,000 from Robert Johnson", expectedAction: "log_offer", severity: "H" },
  { id: "get_deals_1", category: "Pipeline Query", prompt: "What deals do I have?", expectedAction: "get_deals", severity: "H" },
  { id: "get_deal_details_1", category: "Deal Details", prompt: "Tell me about the Main Street deal", expectedAction: "get_deal_details", severity: "M" },
  { id: "archive_deal_1", category: "Deal Lifecycle", prompt: "We closed that deal, mark it done", expectedAction: "archive_deal", severity: "M" },
];

const TOOLS = [
  { name: "fill_forms", description: "Fill out TREC contract forms" },
  { name: "draft_amendment", description: "Draft a TREC 39-10 Amendment" },
  { name: "update_deal_field", description: "Update a field on a dossier" },
  { name: "draft_email", description: "Draft an email for a transaction" },
  { name: "log_offer", description: "Log an offer received" },
  { name: "get_deals", description: "Get information about deals" },
  { name: "get_deal_details", description: "Get details about a deal" },
  { name: "archive_deal", description: "Archive a transaction" },
  { name: "answer_question", description: "Answer a general question" },
];

const SYSTEM_PROMPT = `You are Dossie, a Texas real estate transaction coordinator AI.
EXECUTION RULES:
- Always call a tool. Never respond with plain text.
- Execute immediately without confirmation.
INTENT MAPPING:
- Write/fill contract = fill_forms
- Draft/extend amendment/push closing = draft_amendment
- Update field = update_deal_field
- Draft email = draft_email
- Got offer = log_offer
- What deals = get_deals
- Tell me about/details = get_deal_details
- Archive/close out = archive_deal
- Everything else = answer_question`;

async function testModel(model, prompt) {
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: prompt }],
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    return { success: true, action: toolUse?.name || null, model };
  } catch (error) {
    return { success: false, error: error.message, model };
  }
}

async function main() {
  console.log("Opus vs Sonnet Intent Extraction Test\n");
  const results = {
    timestamp: new Date().toISOString(),
    tests: [],
    summary: { sonnetPass: 0, opusPass: 0, improvements: 0 },
  };

  for (const test of TEST_CASES) {
    process.stdout.write(`${test.id}: `);
    const sonnet = await testModel("claude-sonnet-4-6", test.prompt);
    await new Promise((r) => setTimeout(r, 150));
    const opus = await testModel("claude-opus-4-7-20250219", test.prompt);
    await new Promise((r) => setTimeout(r, 150));

    const sonnetPass = sonnet.success && sonnet.action === test.expectedAction;
    const opusPass = opus.success && opus.action === test.expectedAction;

    if (sonnetPass) results.summary.sonnetPass++;
    if (opusPass) results.summary.opusPass++;
    if (!sonnetPass && opusPass) results.summary.improvements++;

    results.tests.push({
      id: test.id,
      expected: test.expectedAction,
      sonnetAction: sonnet.action,
      opusAction: opus.action,
      sonnetPass,
      opusPass,
      opusImproved: !sonnetPass && opusPass,
    });

    const icon = !sonnetPass && opusPass ? "✅" : sonnetPass && opusPass ? "✓" : "✗";
    console.log(`${icon} (S:${sonnet.action} O:${opus.action})`);
  }

  const total = TEST_CASES.length;
  const sonnetRate = ((results.summary.sonnetPass / total) * 100).toFixed(1);
  const opusRate = ((results.summary.opusPass / total) * 100).toFixed(1);
  const improvementRate = ((results.summary.improvements / total) * 100).toFixed(1);

  console.log("\n" + "=".repeat(60));
  console.log(`Sonnet: ${results.summary.sonnetPass}/${total} (${sonnetRate}%)`);
  console.log(`Opus:   ${results.summary.opusPass}/${total} (${opusRate}%)`);
  console.log(`Improvements: ${results.summary.improvements} (${improvementRate}%)`);

  const rec = improvementRate >= 60 ? "SHIP_OPUS" : improvementRate >= 40 ? "MIXED_APPROACH" : "STAY_SONNET";
  console.log(`Recommendation: ${rec}`);
  console.log("Cost: +$1.20/mo for Opus at current scale");

  fs.writeFileSync(
    "opus-vs-sonnet-results.json",
    JSON.stringify(
      {
        sonnetPassRate: sonnetRate,
        opusPassRate: opusRate,
        improvementRate: improvementRate,
        improvementCount: results.summary.improvements,
        recommendation: rec,
      },
      null,
      2
    )
  );

  console.log("\n✅ Results saved to opus-vs-sonnet-results.json");
}

main().catch(console.error);
