# Tech Debt, Blockers, Next Priorities

## KNOWN TECH DEBT (address before 50 customers)

1. `dossier_milestones` storing `canvas_data_url` in DB → migrate to Supabase Storage.
2. Stripe checkout sessions expire 24h → create permanent Payment Links.
3. Zernio `zernio_post_id` not captured (response shape mismatch).
4. Lifestyle video Zernio post creation not fully wired (upload works, post creation pending).
5. MCP server not published to npm or registries.

---

## NOT DONE / ACTIVE BLOCKERS

- Brokerage compliance document sending (specced, not built — high value)
- Stripe Payment Links (permanent, non-expiring) — current checkout sessions expire 24h
- MCP server registry submissions: MCPT / OpenTools (Smithery ✅ live)
- TikTok automation (manual only until ~May 20, 2026)
- Zernio analytics feedback loop (`post_analytics` table specced, not built)
- Brevo email nurture sequence (segmented agent vs TC)
- Lifestyle video Zernio video-post creation (upload works `put_status=200`; post creation `--auto-post` opt-in only)
- **Amendment drafting** — LIVE incl. NL entry. `api/draft-amendment.js` handles TREC 39-10 (closing_date/option_extension/price_change). NL: Talk to Dossie → `extract-form-fields.js` → `fill-form.js`. Wired 2026-05-28.
- **Fill-and-sign Phase 2** — interactive drag-drop sig/date/initials placement UI on PDF canvas before DocuSeal. Phase 1 auto-places; Phase 2 = visual control. Not built.
- **Fill-and-sign remaining generators** — HOA Addendum (TREC 36-11), Lead-Based Paint (OP-L), Seller's Disclosure (OP-H). PDFs in `Dossie Forms/TREC Base/`, no JS generators.
- **TREC 49-1** (Right to Terminate, Lender's Appraisal — new Jan 2025, split from 40-11). Not in library/generators.
- **Dossier transaction type expansion** — add `transaction_type` field to transactions + auto-load correct package (types: buyer_purchase, seller_listing, new_home_purchase, land_purchase, residential_lease_landlord, residential_lease_tenant). Currently all use same package.
- **More Form Packages** — land, new home, rental landlord, rental tenant. Only Buyer + Seller exist as defaults.
- **Social Media Autopilot** — extend in-house pipeline (cron-generate-posts → DossieMarketingBot → cron-publish-approved → Zernio) to customer-facing add-on. Agents connect FB/IG/LI/TT via Zernio, Dossie drafts daily from listings/market/sphere, Telegram one-tap approval. Cost: ~180 posts/mo @ Haiku = ~$0.30/mo Claude; Zernio flat $18/mo paid. Price: $20/mo ($10 founding). Strategy doc: `SOCIAL-MEDIA-AUTOPILOT-STRATEGY.md`. Flagged 2026-05-21.
- **SMS escalation (Twilio)** — critical deadline + draft-aging alerts. ~$0.0075/msg, ~50¢/agent/mo. Needs phone capture (done) + opt-in toggle. Phase 2 deferred.
- **Voice escalation (Twilio Voice)** — last-resort call when other channels fail. ~$0.013/call. Phase 3 after SMS. Deferred.
- **Customer Education & Onboarding** — Phase 1 welcome email covers all systems, empty-state hints, "What's New" banner. Phase 2 7-day drip, product tour, feature modals. Phase 3 knowledge base `meetdossie.com/help`, tutorials, tooltips. Activation/churn risk. Flagged 2026-05-21.
- **Ginger Unger partnership** — Miki (#5) + likely Amanda found Dossie via her TX RE FB group. Highest-leverage distribution lead. Actions: (a) DM thanks + offer founding spot for review, (b) affiliate % of MRR, (c) paid endorsement / trainings guest. Engage FIRST before posting in group. Heath DM'd 2026-05-21.
- **🚨 URGENT: Form TX LLC + insurance + business bank** — Heath operating as sole prop → unlimited personal liability (house/savings/KW commissions exposed). Steps: (1) TX LLC $300 sos.state.tx.us/SOS Direct, (2) EIN IRS free, (3) business bank, (4) move Stripe/Vercel/Supabase billing to LLC, (5) update WHOIS, (6) Cyber+E&O $50-200/mo (Embroker/Hiscox). #1 PERSONAL ACTION. Do BEFORE next paying customer.
- **Privacy Policy + ToS** — none exist on meetdossie.com → legal exposure. PP must disclose subprocessors (Supabase/Anthropic/Resend/Stripe/ElevenLabs). ToS limits liability. Drafts 2026-05-21; attorney review before live or accept indie-SaaS risk.

---

## NEXT PRIORITIES (in order)

1. MCP server registry submissions (Smithery ✅ live; MCPT + OpenTools pending)
2. Brevo email nurture (agent vs TC segmented)
3. Zernio analytics feedback loop
4. Lifestyle video Zernio post creation (upload works; post creation pending)
5. TikTok automation gate flip (~May 20, 2026)

(Done 2026-05-07: Stripe Payment Links, brokerage compliance send, LinkedIn Zernio, first-time onboarding checklist, MCP server npm+HTTP.)
