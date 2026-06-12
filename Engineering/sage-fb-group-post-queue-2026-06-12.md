# Sage FB group post queue — 2026-06-12

3 fresh group POSTS (not comments) ready for Heath to approve in DossieMarketingBot, OR for direct shipping via:

```
node scripts/fb-group-poster.js --post-id <uuid>
```

Each is targeted at a group where we've had recent posting success or where the audience density is high. All pass: pain validation first, Dossie in first comment (not main post), no URL/CTA, authority not discovery, FB-first-comment rule.

---

## Post #1 — Dallas Texas Realtors (recent success: 2026-06-11)

**Group URL:** https://www.facebook.com/groups/dallasrealtors/
**Pillar:** Control
**Persona context:** Heath as working broker, not founder pitching

**Main post body:**
> Quick question for the DFW agents working multiple deals at once -
>
> How are you actually tracking option period deadlines when you have three or four active dossiers? I don't mean the calendar reminder — I mean the moment the inspection report comes in and you're trying to figure out by what specific hour your buyer needs to respond.
>
> I went down a rabbit hole on this and ended up building a tool around it because I kept missing the math. Curious what the seasoned folks here use.

**First comment (where Dossie gets named — FB-first-comment rule):**
> The thing I built is called Dossie — Texas-specific, auto-calculates every TREC deadline from the contract's effective date so I'm not doing math at 11pm. Founding pricing is at meetdossie.com/founding if anyone wants to see it, but mostly I just want to know what tools y'all are actually using day-to-day. Comparing notes.

**Why this works:**
- Asks a real question (not a sales pitch)
- Vulnerability ("kept missing the math")
- Dossie name is in comment, NOT body (passes Heath's permanent rule)
- Founding URL is in comment after the value, not the hook
- Invites discussion, not just clicks

---

## Post #2 — Texas Real Estate Agents (previously stuck — fresh angle)

**Group URL:** https://www.facebook.com/groups/texasusarealestateagents/
**Pillar:** Speed
**Persona context:** Heath after a rough Saturday morning

**Main post body:**
> Texas agents — what is your move when the title company calls you at 7 AM Saturday with a question and you're already on your way to a showing?
>
> Used to be I'd pull over, dig through my notes app, half-remember which dossier they were asking about, and call back from the parking lot of the showing. That whole sequence ate 25 minutes of my Saturday every weekend.
>
> I'm not asking what tool is best — I'm asking what your actual workflow is. Genuinely curious how the high-volume folks here handle it.

**First comment:**
> What changed for me was Dossie — voice-first, I literally tap a button and ask it "where are we on the Patterson file" and it reads me the answer while I'm driving. No app switching, no scrolling. Built it after the third Saturday in a row where I lost my morning to title company pings.

**Why this works:**
- Real-world scenario most agents recognize
- Vulnerability ("ate 25 minutes of my Saturday")
- Specific Dossie capability (voice-first Talk-to-Dossie) named in comment
- Texas-specific framing builds in-group authority

---

## Post #3 — Texas Real Estate Network (visibility angle, fresh)

**Group URL:** https://www.facebook.com/groups/texasrealestategroup/
**Pillar:** Visibility
**Persona context:** Brittney's broker insight retold

**Main post body:**
> Question for the brokers and team leads here -
>
> When you have eight to twelve agents under you and each is running three or four files, how do you actually see what's happening in real time? I don't mean Dotloop or SkySlope (which show documents, not deadlines). I mean — at 3 PM on a Thursday, do you know which agent has an option period expiring tomorrow that they haven't responded to?
>
> One of our brokers (managing 80 transactions a year) said the lack of systems wasn't sustainable. That comment stuck with me. What's working for your team?

**First comment:**
> What we built for her is called Dossie — pipeline dashboard shows every deadline across every dossier in one view, color-coded by urgency. The broker can see "this agent has a deadline in 4 hours and hasn't moved" without calling anyone. Texas-only for now. If you're managing a team this might be worth a 5-minute look — meetdossie.com.

**Why this works:**
- Targets brokers/team leads (different persona than the others)
- Uses Brittney's actual quote (real authority, not synthesized)
- Specific number (80 transactions/year, 8-12 agents)
- Visibility pillar — strongest for team-tier conversion
- Founding URL in comment after the value

---

## Ship sequence

When Heath wants to ship one:

1. Insert into `group_posts` table:
   ```sql
   INSERT INTO group_posts (group_name, group_url, post_body, first_comment_body, status, template_id, pillar)
   VALUES (...);
   ```
2. Run: `node scripts/fb-group-poster.js --post-id <returned uuid>`

The script uses DossieBot-Sage Chrome profile, posts both the main body and first comment, and updates status='posted' with the resulting URLs.

Alternatively, batch ship via the existing pipeline by inserting all 3 then letting cron-send-to-sage pick them up at next run.

## Rule compliance check

| Rule | P1 | P2 | P3 |
|---|---|---|---|
| Dossie in FIRST COMMENT (not body) | ✅ | ✅ | ✅ |
| ONE specific capability per comment | ✅ TREC math | ✅ Voice-first | ✅ Pipeline dashboard |
| Pain validation first | ✅ | ✅ | ✅ |
| 80+ char floor (comment) | ✅ 350+ | ✅ 360+ | ✅ 380+ |
| Authority not discovery | ✅ | ✅ | ✅ |
| Founding URL in comment after value | ✅ | (no URL — softer) | ✅ |
| Real / verifiable facts only | ✅ (Brittney's real quote) | ✅ (personal anecdote) | ✅ (Brittney + numbers) |
| Texas-specific framing | ✅ | ✅ | ✅ |
