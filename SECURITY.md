# SECURITY POLICY

## Sensitive Files

### `.env.production.local`

**CRITICAL:** This file contains production API keys, database credentials, and other secrets.

**Security rules:**
- ✅ **IS** gitignored (via `.env*.local` pattern in `.gitignore`)
- ❌ **NEVER** commit to git
- ❌ **NEVER** share via Slack, email, or messaging
- ❌ **NEVER** paste in browser, screenshot, or screen-record
- ✅ **ONLY** sync via `npx vercel env pull .env.production.local`

**Contents include:**
- Supabase service role key (bypasses RLS)
- Stripe secret key (charges cards)
- Telegram bot tokens (sends messages)
- ElevenLabs API key (generates voice)
- Anthropic API key (AI content generation)
- Resend API key (sends emails)
- All other production secrets

**If compromised:**
1. Immediately rotate ALL keys (see RUNBOOK.md)
2. Check `/api/health` for unauthorized usage
3. Review Stripe dashboard for unauthorized charges
4. Check Supabase logs for suspicious queries
5. Document in new `INCIDENT-YYYY-MM-DD.md` file

---

## Pending Security Tasks

### 1. **git-crypt encryption** (High Priority)
**Status:** Not implemented  
**Risk:** If filesystem is compromised, `.env.production.local` is readable plaintext  
**Mitigation:** Install git-crypt and encrypt `.env.production.local` at rest

**Setup steps:**
```bash
# Install git-crypt
choco install git-crypt

# Initialize git-crypt in repo
git-crypt init

# Create .gitattributes to encrypt .env.production.local
echo ".env.production.local filter=git-crypt diff=git-crypt" >> .gitattributes

# Export encryption key to secure location (NOT in repo)
git-crypt export-key ~/dossie-git-crypt.key

# Verify encryption
git-crypt status
```

**Resources:**
- https://github.com/AGWA/git-crypt
- https://git-crypt.github.io/

### 2. **Secret scanning in CI/CD** (Medium Priority)
**Status:** Not implemented  
**Risk:** Could accidentally commit a secret to GitHub  
**Mitigation:** Add GitGuardian or `gitleaks` to pre-commit hooks

**Setup:**
```bash
# Install gitleaks
choco install gitleaks

# Add pre-commit hook
# .git/hooks/pre-commit
gitleaks protect --staged --verbose
```

### 3. **Endpoint protection on dev machine** (High Priority)
**Status:** Not implemented (malware incident 2026-05-08)  
**Risk:** Malware can steal secrets from filesystem or memory  
**Mitigation:** Install Windows Defender + Malwarebytes

### 4. **Audit logging for API key usage** (Low Priority)
**Status:** Not implemented  
**Risk:** Can't detect unauthorized key usage until damage is done  
**Mitigation:** Enable audit logs in Stripe, Supabase, ElevenLabs dashboards

### 5. **Backup alert channel** (Medium Priority)
**Status:** Not implemented  
**Risk:** If Telegram is down, no alerts  
**Mitigation:** Add email alerting via Resend as fallback

### 6. **Rate limiting on `/api/config`** (Low Priority)
**Status:** Not implemented  
**Risk:** Could be DoS vector or key scraping target  
**Mitigation:** Add Vercel edge config rate limiting (10 req/min per IP)

---

## Reporting a Vulnerability

If you discover a security issue:

1. **DO NOT** open a public GitHub issue
2. **DO** email heath@meetdossie.com with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if known)

We aim to respond within 24 hours and patch critical issues within 72 hours.

---

## Security Contact

- **Email:** heath@meetdossie.com
- **Telegram:** @heathshepard (for urgent/active incidents only)

---

Last updated: 2026-05-08 (Post-resilience sprint)
