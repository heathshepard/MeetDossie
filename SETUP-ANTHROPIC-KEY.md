# Setup Anthropic API Key

The chat API is deployed but needs your Anthropic API key to work.

## Get Your API Key

1. Go to https://console.anthropic.com/
2. Sign in or create account
3. Go to API Keys section
4. Create new key (or use existing)
5. Copy the key (starts with `sk-ant-api03-...`)

## Add to Vercel

### Option 1: Via CLI (Recommended)

```bash
cd "C:\Users\Heath Shepard\Desktop\MeetDossie"
vercel env add ANTHROPIC_API_KEY
```

When prompted:
- **Value:** Paste your key (`sk-ant-api03-...`)
- **Environments:** Select all (Production, Preview, Development)
- Press Enter

### Option 2: Via Dashboard

1. Go to https://vercel.com/heathshepard-6590s-projects/meet-dossie/settings/environment-variables
2. Click "Add New"
3. Key: `ANTHROPIC_API_KEY`
4. Value: Your key (`sk-ant-api03-...`)
5. Environments: Check all three boxes
6. Click Save

## Redeploy (if using dashboard)

After adding via dashboard, trigger redeploy:

```bash
vercel --prod
```

Or just push another commit to GitHub.

## Test It Works

```bash
curl -X POST https://meet-dossie-lc4mv5ruz-heathshepard-6590s-projects.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello Dossie","userId":"test-user-123"}'
```

Should return:
```json
{
  "ok": true,
  "reply": "Hi! I'm Dossie...",
  "model": "claude-haiku-4",
  "remaining": 49
}
```

## Troubleshooting

**Error: "Server configuration error"**
- API key not set or wrong environment
- Check Vercel dashboard → Settings → Environment Variables
- Make sure it's enabled for Production

**Error: "Invalid API key"**
- Key is incorrect or expired
- Get new key from console.anthropic.com
- Update in Vercel

**Error: "Rate limit exceeded" (from Anthropic)**
- Your Anthropic account hit limits
- Check your usage at console.anthropic.com
- May need to upgrade plan

## Next Step

Once this works, the frontend can be wired to call `/api/chat` instead of the local Python server.
