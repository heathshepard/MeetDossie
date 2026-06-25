-- Seed future_builds with Pierce's realtor-to-personal candidates + Heath's ideas
-- 2026-06-25 Carter draft
-- NOTE: Replace 0cd05e2f-491f-411f-afe7-f8d3fbbdbff6 with actual Heath's auth.users.id before running

INSERT INTO public.jarvis_future_builds (
  tenant_id, title, description, source, score, status, 
  source_doc_path, prerequisite, bridges_personal_assistant
) VALUES
  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'SOI Relationship Memory', 
   'Track agent relationships + key moments (birthdays, anniversaries, kids, pets, recent transactions). Auto-prompt on calendar events or CRM refresh.',
   'pierce_5 research', 35, 'idea', 
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Mileage + Expense Brain',
   'Automatic mileage tracker (iOS Health + passthrough expense logging). Weekly/monthly summaries for tax deduction.',
   'pierce_5 research', 31, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Vendor Find Me a Pro',
   'On-demand recommendations for contractors, inspectors, lenders, title cos. Weighted by agent network + peer reviews.',
   'pierce_5 research', 31, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Closing Gifts to Personal Gifts',
   'Automated gift suggestions + ordering for client closings. Extends to personal milestones (birthdays, new baby). White-glove vendor integration.',
   'pierce_5 research', 31, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Home Maintenance Household OS',
   'Turns post-closing maintenance checklist + vendor list into proactive household task mgmt. Seasonal reminders, HVAC filters, roof inspections, pest control.',
   'pierce_5 research', 30, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Showing Scheduler General Appointment Booker',
   'Generalize showing scheduling (clients + team) to all personal/professional appointments. Tie to Jarvis voice for same interface.',
   'pierce_5 research', 28, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Move Coordination Life-Event Coordinator',
   'Extend move coordination (closing → movers → utilities → address updates) to all life events (weddings, new baby, career change). Checklists + vendor network + automation.',
   'pierce_5 research', 27, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Open House Guest Tracking Event Guest Management',
   'Generalize open house guest tracking (QR check-in, follow-up emails, feedback) to all personal events (parties, weddings, receptions). RSVP management + gift registry.',
   'pierce_5 research', 26, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', NULL, true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Email Triage',
   'Inbox intelligence: priority routing, auto-drafting responses, action extraction. Solves "lost in email" pain for agents.',
   'pierce_5 research', 24, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', 
   'blocked by Dossie Sign', true),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Closing Day Orchestration',
   'Real-time coordination + checklist execution for closing day (docs + signatures + wire transfers + keys + final walkthrough). Extends Dossie Sign + DocuSeal into realtime operations.',
   'pierce_5 research', 23, 'idea',
   'Shepard-Ventures/Marketing/research/2026-06-24-realtor-to-personal-assistant-integrations.md', 
   'blocked by Dossie Sign', false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Jarvis SaaS',
   'Standalone subscription with vault + wallet. White-glove first-deal setup + concierge $149. Builds on Dossie personal assistant foundation.',
   'Heath direct idea', NULL, 'idea',
   'project_jarvis_saas_vault_wallet.md', NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Bitwarden-backed password vault',
   'Bitwarden integration for agent + client password + document management. Part of Jarvis SaaS. White-label capable.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Pre-funded wallet for agent purchases',
   'Agent funding account for vendor/subscription purchases. Bridges agent brokerage + Dossie commerce. Part of Jarvis SaaS.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Travel rebook capability',
   'Train/flight/hotel agent. Proven by SNCF pain (2026-06-24). Cord-cutting for multi-leg itineraries.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Cold email to TX agents',
   'Full Apollo + Instantly stack. Proven playbook. Acceleration of founding member acquisition.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Founder ambassador program',
   'Founding members as referral network. $50/referral, white-glove onboarding.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false),

  ('0cd05e2f-491f-411f-afe7-f8d3fbbdbff6', 'Concierge white-glove first-deal setup',
   'First-deal onboarding + Dossie configuration + transaction template setup. Premium tier. Bridges solo to scale.',
   'Heath direct idea', NULL, 'idea', NULL, NULL, false)
ON CONFLICT DO NOTHING;
