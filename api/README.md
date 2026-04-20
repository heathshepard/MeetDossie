# Dossie Chat API

Serverless conversation backend for Dossie.

## Endpoint

`POST /api/chat`

## Request

```json
{
  "message": "What documents do I need for a buyer side deal?",
  "userId": "user-uuid-from-supabase",
  "transactionContext": {
    "buyer_name": "Sarah Martinez",
    "property_address": "123 Main St",
    "stage": "under-contract"
  }
}
```

**Fields:**
- `message` (required): User's message as a string
- `userId` (required): Unique user identifier for rate limiting
- `transactionContext` (optional): Current transaction data if available

## Response

### Success (200)

```json
{
  "ok": true,
  "reply": "For a buyer side transaction, you'll typically need...",
  "model": "claude-haiku-4",
  "remaining": 49,
  "resetAt": 1713657600000
}
```

**Fields:**
- `ok`: Boolean success indicator
- `reply`: Dossie's response text
- `model`: Which Claude model was used (haiku or sonnet)
- `remaining`: Messages remaining in rate limit window
- `resetAt`: Unix timestamp when rate limit resets

### Rate Limit Exceeded (429)

```json
{
  "ok": false,
  "error": "Rate limit exceeded. You've used your 50 daily messages. Resets at 2026-04-21T18:00:00.000Z.",
  "remaining": 0,
  "resetAt": 1713657600000
}
```

### Error (400/500)

```json
{
  "ok": false,
  "error": "Error message here"
}
```

## Model Routing

- **Haiku** (fast, general conversation): Used when no transaction context or general questions
- **Sonnet** (reasoning, transaction updates): Used when transaction context is present or message contains transaction keywords

## Rate Limiting

- **Free tier**: 50 messages per user per day
- **Window**: 24 hours rolling
- **Storage**: In-memory (use Redis/Vercel KV for production)

## Environment Variables

Add to Vercel project settings:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
```

Get your key at https://console.anthropic.com/

## Local Development

1. Create `.env.local`:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-...
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run Vercel dev server:
   ```bash
   vercel dev
   ```

4. Test endpoint:
   ```bash
   curl -X POST http://localhost:3000/api/chat \
     -H "Content-Type: application/json" \
     -d '{"message":"Hello Dossie","userId":"test-user"}'
   ```

## Security

- API key is server-side only, never exposed to frontend
- Rate limiting prevents abuse
- CORS enabled for frontend access
- Input validation on all fields
