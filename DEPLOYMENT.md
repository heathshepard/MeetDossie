# Dossie Deployment Guide

## Required Environment Variables

### Anthropic API Key (Required for Chat API)

Get your key at https://console.anthropic.com/

Add to Vercel:

```bash
vercel env add ANTHROPIC_API_KEY
```

When prompted:
- Value: `sk-ant-api03-...` (your actual key)
- Environments: Production, Preview, Development (select all)

Or add via Vercel dashboard:
1. Go to https://vercel.com/heathshepard-6590s-projects/meet-dossie/settings/environment-variables
2. Add `ANTHROPIC_API_KEY`
3. Set value to your Anthropic API key
4. Enable for Production, Preview, Development
5. Save

## Verify Deployment

After pushing to GitHub, Vercel auto-deploys. Check:

```bash
vercel ls
```

Latest deployment should show "Ready" status.

Test the chat API:

```bash
curl -X POST https://meet-dossie-8xvnczon4-heathshepard-6590s-projects.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello Dossie","userId":"test-user-123"}'
```

Expected response:

```json
{
  "ok": true,
  "reply": "Hi! I'm Dossie...",
  "model": "claude-haiku-4",
  "remaining": 49,
  "resetAt": 1713657600000
}
```

## Local Development

1. Create `.env.local`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run dev server:
   ```bash
   vercel dev
   ```

4. Test locally:
   ```bash
   curl -X POST http://localhost:3000/api/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"Hello Dossie","userId":"test-user"}'
   ```

## Deployment Status

Latest commit: `03f6e69` - Add serverless chat API
Deployed to: Vercel (auto-deploy on push to main)
API endpoint: `/api/chat`
Rate limit: 50 messages per user per day

## Next Steps

1. Add `ANTHROPIC_API_KEY` to Vercel environment variables
2. Redeploy (or wait for next push to trigger auto-deploy)
3. Test `/api/chat` endpoint with curl or Postman
4. Wire frontend to call `/api/chat` instead of transaction intelligence directly
5. Remove `DOCUMENT_BRIDGE_URL` hardcoded localhost reference from frontend
