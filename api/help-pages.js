// Vercel Serverless Function: /api/help-pages
// Returns help knowledge base pages as JSON. Can be called from React to populate /help routes.
//
// GET /api/help-pages — returns all help pages
// GET /api/help-pages?slug=getting-started — returns one page
// POST /api/help-pages/feedback { page_slug, helpful, comment? }
//
// Authorization: Bearer <supabase user JWT> for feedback POST

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Help page content — sourced from Pierce's spec
const HELP_PAGES = {
  index: {
    slug: 'index',
    title: 'Dossie Help',
    intro: 'You\'re paying for it — here\'s how to use every part. Each section is 2 minutes to read. If you can\'t find what you need, reply to the email Heath sent you when you joined and he\'ll answer personally.',
    sections: [
      { title: 'Getting Started', slug: 'getting-started', description: 'Your first dossier, first contract, first morning brief.' },
      { title: 'Morning Brief', slug: 'morning-brief', description: 'How the 6am audio summary works.' },
      { title: 'Talk to Dossie', slug: 'talk-to-dossie', description: 'Voice commands and what she can do.' },
      { title: 'DossieSign', slug: 'dossiesign', description: 'Filling TREC forms and sending for signature.' },
      { title: 'TREC Deadlines', slug: 'trec-deadlines', description: 'How auto-calculation works and where the citations come from.' },
      { title: 'Compliance Vault', slug: 'compliance-vault', description: 'Brokerage doc organization.' },
      { title: 'Closing Milestone Cards', slug: 'sharing-milestones', description: 'Sharing your wins.' },
      { title: 'FAQ', slug: 'faq', description: 'Everything else.' },
    ],
    footer: 'Built by Heath Shepard, licensed Texas REALTOR. Reply to your welcome email any time. heath@meetdossie.com.',
  },
  'getting-started': {
    slug: 'getting-started',
    title: 'Getting Started in 5 Minutes',
    sections: [
      {
        heading: 'Set your password and log in',
        content: 'After you bought your founding spot, two emails went to your inbox. One says "Welcome to Dossie" (from Heath). One says "Set your password" (from Dossie). Tap the "Set your password" email first, pick a password, and you\'re in. If the password email got buried in spam, check there. If it expired, reply to the welcome email and Heath sends a new one within an hour.',
      },
      {
        heading: 'Create your first dossier',
        content: 'Go to meetdossie.com/app. You\'ll land on your pipeline — which is empty right now. Tap "Create new dossier" in the top right. Pick a deal you\'re currently working, or even a closed one from last month (a closed deal is a great test — no live risk, all the deadline math still works). Enter the property address.',
      },
      {
        heading: 'Upload the contract',
        content: 'On the dossier page, drag the contract PDF directly onto the page. Or tap "Upload document" and pick it. Dossie reads the PDF, pulls every TREC deadline with the paragraph citation, and updates the dossier in about 10 seconds. You\'ll see option period, financing contingency, closing date — all cited.',
      },
      {
        heading: 'Check tomorrow morning',
        content: 'At 6am the next morning, Dossie generates your Morning Brief — a 90-second audio summary of what\'s due, what closed, what needs your eyes. Open the app, tap "Morning Brief" on the dashboard. You can also read the text version if you don\'t want to listen.',
      },
      {
        heading: 'Try Talk to Dossie',
        content: 'On any dossier page, tap the mic icon in the workspace. Say something like "Draft a follow-up to the lender about the appraisal status." She transcribes, drafts the email, and queues it for you to review and send.',
      },
    ],
    footer: 'That\'s the core loop. Everything else (forms, DossieSign, packages, milestone cards) layers on top.',
  },
  'morning-brief': {
    slug: 'morning-brief',
    title: 'Your 6am Morning Brief',
    sections: [
      {
        heading: 'What\'s in the brief',
        content: 'The brief covers four things in order: deadlines today, deadlines tomorrow, anything that closed in the last 24 hours, and any action items that need your attention. It\'s roughly 90 seconds at a normal listening pace.',
      },
      {
        heading: 'Where to find it',
        content: 'Open the app at meetdossie.com/app. The brief is on the main dashboard — tap "Morning Brief" and the audio plays. If you prefer to read, the text version is right below the play button.',
      },
      {
        heading: 'Why you might miss the first few',
        content: 'The brief generates whether you check the app or not. Most agents miss the first few because they\'re not used to checking the app at 6am. Build the habit: tap it while you\'re making coffee for the first week.',
      },
      {
        heading: 'When the brief is empty',
        content: 'If you have no active deals (or your only dossiers are closed-and-archived), the brief is short or skipped that day. Once you add an active deal, the brief picks up the next morning.',
      },
      {
        heading: 'Customizing the voice',
        content: 'Dossie\'s voice is Luna (the friendly, conversational voice). If you\'d prefer a different voice or want to skip the audio entirely, that setting lives in Settings → Notifications.',
      },
    ],
    footer: 'The brief gets sharper the more you use Dossie. If something in the brief is wrong, reply to your welcome email and tell Heath — that\'s how the product improves.',
  },
  'talk-to-dossie': {
    slug: 'talk-to-dossie',
    title: 'Talk to Dossie — Voice Commands',
    sections: [
      {
        heading: 'Where to find the mic',
        content: 'In the workspace (meetdossie.com/workspace) or on any individual dossier page, there\'s a mic icon. Tap it, speak, tap to stop. Dossie transcribes and acts.',
      },
      {
        heading: 'What she can do',
        content: 'Three categories of commands:\n\nUpdate a deal:\n• "Move the option period on 1847 Vintage to next Friday."\n• "Add a note that the inspection report came back clean."\n• "Set closing date to June 28 for the Anderson deal."\n\nDraft an email:\n• "Draft a follow-up to the lender about the appraisal status."\n• "Write a reminder to the buyer that earnest money is due tomorrow."\n• "Draft a thank-you to the listing agent for the smooth signing."\n\nFill a contract or form:\n• "Fill a TREC resale contract for 123 Main Street, buyer Sarah Whitley, $450,000."\n• "Draft an amendment to extend the closing date by 7 days."',
      },
      {
        heading: 'How she handles ambiguity',
        content: 'If she\'s missing details, she asks. Example: you say "draft a follow-up to the lender" but the dossier has two lenders. Dossie replies with "Which one — Wells Fargo or Citibank?" and waits for the answer.',
      },
      {
        heading: 'Editing what she drafted',
        content: 'Every email or form Dossie drafts lands in your review queue. Open it, edit anything you want, tap send. She never sends on her own — you stay in control.',
      },
      {
        heading: 'Voice in noisy environments',
        content: 'The mic uses your device\'s microphone. If you\'re somewhere noisy (open house, lobby, drive-thru), the transcription quality drops. The fix: speak slightly slower and closer to the phone. Or just type — the text input next to the mic does everything the voice does.',
      },
    ],
    footer: 'Talk to Dossie is the feature most agents say "I didn\'t realize you meant LITERALLY talk to her" about. Try it once and you\'ll start using it daily.',
  },
  'dossiesign': {
    slug: 'dossiesign',
    title: 'DossieSign — Fill, Sign, Send',
    sections: [
      {
        heading: 'How it works',
        content: 'Open any dossier. Tap the "Forms" tab. Pick the form you need — for example, TREC One to Four Family Residential Contract (20-18) or a financing addendum. Dossie pre-fills every field she can from the contract data already in the dossier (party names, property address, dates). You review, fill any gaps, and tap "Send for signature."',
      },
      {
        heading: 'What forms are supported',
        content: 'Today: TREC resale contract (20-18), financing addendum (40-11), amendment (39-10), termination notice (38-7). Coming next: HOA Addendum (36-11), Lead-Based Paint Addendum (OP-L), Seller\'s Disclosure Notice (OP-H), TREC 49-1 (right to terminate due to lender\'s appraisal).',
      },
      {
        heading: 'Form Packages',
        content: 'Instead of attaching forms one by one, tap "Packages" in the Forms tab. Two system defaults: Buyer Transaction (every form a buyer-side deal typically needs) and Seller Transaction (same for listings). Tap "Apply Package" and Dossie attaches all of them at once, pre-filled from your dossier.',
      },
      {
        heading: 'Sending for signature',
        content: 'Once you\'ve filled the form, tap "Send for signature." A modal asks for the signers\' email addresses. Dossie sends each signer a secure link, tracks signature status, and lands the completed PDF back in the dossier when everyone has signed.',
      },
      {
        heading: 'When something doesn\'t fill',
        content: 'If a field doesn\'t pre-fill, it\'s usually because the source contract didn\'t have that data extractable. Add it manually in the form and Dossie will remember it for the next form on the same dossier.',
      },
      {
        heading: 'Compliance',
        content: 'Signed PDFs are stored in your dossier and also routed to your Compliance Vault if you have one configured. You stay in control of where your docs live.',
      },
    ],
    footer: 'DossieSign replaces the back-and-forth of sending paper forms to a TC, getting them back, mailing them to the signer. One tap.',
  },
  'trec-deadlines': {
    slug: 'trec-deadlines',
    title: 'TREC Deadlines Explained',
    sections: [
      {
        heading: 'Which deadlines she calculates',
        content: 'For every contract you upload, Dossie pulls and calculates:\n• Option period expiration (date and time)\n• Earnest money deadline\n• Financing contingency expiration\n• Survey delivery deadline\n• HOA documents deadline\n• Title commitment deadline\n• Closing date\n• Possession date\n• Plus any custom deadlines specified in addenda',
      },
      {
        heading: 'How citations work',
        content: 'Every deadline lands with a "TREC ¶" citation — for example, "Option Period — Para 23." Tap the citation in any dossier and the relevant paragraph of the contract opens in a popup. You see exactly which language drives the deadline.',
      },
      {
        heading: 'When the contract is ambiguous',
        content: 'If the contract is silent on a deadline or has conflicting language, Dossie flags it as "Needs review" rather than guessing. You\'ll see a yellow indicator and a one-line explanation of what\'s ambiguous.',
      },
      {
        heading: 'Customizing reminders',
        content: 'By default Dossie sends a deadline reminder 7 days out, 1 day out, and the morning of. You can change this in Settings → Notifications. Most agents leave the defaults.',
      },
      {
        heading: 'Why this matters',
        content: 'Missed TREC deadlines cause failed deals, legal exposure, and sometimes license discipline. Dossie was built so a Texas agent never wakes up at 4:30am wondering if she missed an option-period date.',
      },
    ],
    footer: 'If a deadline looks wrong to you, reply to your welcome email and tell Heath. The deadline engine improves directly from agent feedback.',
  },
  'compliance-vault': {
    slug: 'compliance-vault',
    title: 'Compliance Vault',
    sections: [
      {
        heading: 'Note: Compliance Vault is in development',
        content: 'Compliance Vault is a $10/mo add-on for founding members. This page describes the full feature once it ships. If you\'re a founding member and want early access, reply to your welcome email and Heath will add you to the beta list.',
      },
      {
        heading: 'How it works',
        content: 'Upload your brokerage\'s compliance checklist once. Dossie reads it and creates a folder structure that matches what your broker expects. For every new dossier, Dossie suggests which docs need to go into that transaction\'s compliance folder.',
      },
      {
        heading: 'Sending to your broker\'s portal',
        content: 'If your brokerage uses SkySlope, Dotloop, BrokermintPro, or one of the major compliance platforms, Dossie can either email the packet directly or generate a ZIP file for you to upload manually. (Direct email works for portals that accept emailed submissions; ZIP is the fallback when the portal requires manual upload.)',
      },
      {
        heading: 'Tracking compliance status',
        content: 'Every transaction has a compliance progress indicator on the dossier card — green when everything\'s filed, yellow when something\'s missing, red when a required doc is overdue.',
      },
      {
        heading: 'Privacy',
        content: 'Compliance docs are stored encrypted in your account. Your broker sees only what you send them, when you send it.',
      },
    ],
    footer: 'Compliance Vault is a $10/mo add-on. Founding members get it at 50% off forever. Add it from Settings → Subscription when it\'s ready.',
  },
  'sharing-milestones': {
    slug: 'sharing-milestones',
    title: 'Closing Milestone Cards',
    sections: [
      {
        heading: 'How a card is generated',
        content: 'Mark a dossier as "Closed" — Dossie automatically creates the milestone card. You\'ll see it in the dossier\'s "Milestones" tab and on your main dashboard as a closed-deal badge.',
      },
      {
        heading: 'What\'s on the card',
        content: 'Property address (you can customize how much detail — full address, city only, or a generic "Just Closed"). Closing date. The Dossie wordmark in the corner. Nothing about your buyer, your seller, the price, or any other private data unless you explicitly add it.',
      },
      {
        heading: 'Sharing the card',
        content: 'Tap "Share" on any milestone card. Three options: copy the image to your clipboard (then paste anywhere), share to Facebook directly, or send via text (the SMS option opens your phone\'s text app pre-loaded).',
      },
      {
        heading: 'Privacy',
        content: 'Cards never include client names, prices, or contract details by default. You can add a custom caption, but the card image itself is privacy-safe.',
      },
      {
        heading: 'Why this exists',
        content: 'Closings are how agents stay top-of-mind in their sphere. The card takes 2 minutes and looks like you spent 20.',
      },
    ],
    footer: 'The Share button lives in the sidebar (desktop) and the bottom nav (mobile). Tap it any time to share a card you\'ve already generated.',
  },
};

async function handleGet(req, res, userId) {
  const { slug } = req.query;

  if (slug) {
    const page = HELP_PAGES[slug];
    if (!page) {
      return res.status(404).json({ ok: false, error: `No help page found: ${slug}` });
    }
    return res.status(200).json({ ok: true, page });
  }

  // Return all pages (index mode)
  const pages = Object.values(HELP_PAGES).map((p) => ({
    slug: p.slug,
    title: p.title,
  }));

  return res.status(200).json({ ok: true, articles: pages });
}

async function handlePostFeedback(req, res, userId) {
  const { page_slug, helpful, comment } = req.body || {};

  if (page_slug === undefined || helpful === undefined) {
    return res.status(400).json({ ok: false, error: 'page_slug and helpful are required' });
  }

  try {
    const { error } = await supabase
      .from('help_feedback')
      .insert({
        user_id: userId,
        page_slug,
        helpful,
        comment: comment || null,
      });

    if (error) {
      console.error('Help feedback insert error:', error);
      return res.status(500).json({ ok: false, error: 'Failed to record feedback' });
    }

    return res.status(200).json({ ok: true, recorded: true });
  } catch (err) {
    console.error('Help feedback error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    // GET endpoints don't require auth (help is public, or logged-in users can fetch their own feedback intent)
    return handleGet(req, res, null);
  }

  if (req.method === 'POST') {
    // POST feedback requires auth
    let userId;
    try {
      const auth = await verifySupabaseToken(req);
      userId = auth.userId;
    } catch (err) {
      const status = err instanceof AuthError && err.status ? err.status : 401;
      return res.status(status).json({ ok: false, error: 'Unauthorized' });
    }

    return handlePostFeedback(req, res, userId);
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method not allowed.' });
};
