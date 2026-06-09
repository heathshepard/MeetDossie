# n8n Integration Guide

**Status:** Live (cloud-hosted)
**Base URL:** `https://meetdossie.app.n8n.cloud`
**API key:** stored as `N8N_API_KEY` in `.env.local`
**MCP token:** stored as `N8N_MCP_TOKEN` in `.env.local`
**MCP URL:** `https://meetdossie.app.n8n.cloud/mcp-server/http`

---

## How to create a webhook trigger workflow

1. Open `https://meetdossie.app.n8n.cloud`
2. Click **New Workflow**
3. Add a **Webhook** trigger node (search: "Webhook")
4. Set HTTP Method to `POST`
5. Set Authentication to **Header Auth** -- Header Name: `Authorization`, Value: `Bearer {your token}`
6. Copy the production webhook URL (shown in the node -- looks like `https://meetdossie.app.n8n.cloud/webhook/{uuid}`)
7. Add your processing nodes after the Webhook trigger
8. **Activate** the workflow (toggle in top right) -- inactive workflows reject all incoming calls

---

## How Cole calls n8n workflows via the REST API

### Trigger a webhook directly (simplest pattern)

```bash
curl -X POST https://meetdossie.app.n8n.cloud/webhook/{workflow-webhook-uuid} \
  -H "Authorization: Bearer {N8N_MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

### List active workflows via the n8n REST API

```bash
curl https://meetdossie.app.n8n.cloud/api/v1/workflows?active=true \
  -H "X-N8N-API-KEY: {N8N_API_KEY}"
```

### Trigger a workflow execution via the n8n REST API

```bash
curl -X POST https://meetdossie.app.n8n.cloud/api/v1/workflows/{workflowId}/run \
  -H "X-N8N-API-KEY: {N8N_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"data": {"key": "value"}}'
```

Note: `workflowId` is the numeric or UUID ID shown in the workflow URL when editing.

---

## Example: Batch Gmail draft creation (Pierce outreach batches)

**Use case:** Pierce has a list of names + emails. Cole calls n8n with the batch.
n8n iterates the list and creates Gmail drafts via the Gmail node.

### n8n workflow structure

```
Webhook (POST /webhook/{uuid})
  -> Code node (parse input.contacts array)
  -> Loop Over Items
    -> Gmail: Create Draft
        To: {{ $json.email }}
        Subject: {{ $json.subject }}
        Body: {{ $json.body }}
```

### Call pattern from Cole (or from a Vercel API route)

```javascript
const contacts = [
  { email: 'broker@example.com', name: 'Jane', subject: 'Dossie for your team', body: '...' },
  { email: 'agent@example.com', name: 'Bob', subject: 'Dossie for your team', body: '...' },
];

const res = await fetch('https://meetdossie.app.n8n.cloud/webhook/{uuid}', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.N8N_MCP_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ contacts }),
});
const result = await res.json();
```

### Vercel API route wrapper

Create `api/trigger-n8n.js`:

```javascript
module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false });
  }
  const { workflow_id, payload } = req.body;
  const n8nRes = await fetch(
    `https://meetdossie.app.n8n.cloud/webhook/${workflow_id}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.N8N_MCP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );
  const data = await n8nRes.json().catch(() => null);
  return res.status(200).json({ ok: n8nRes.ok, data });
};
```

Add `N8N_MCP_TOKEN` to Vercel env vars if calling from server-side routes.

---

## Security notes

- Use `N8N_MCP_TOKEN` for webhook calls (MCP-scoped, least privilege)
- Use `N8N_API_KEY` only for admin API calls (list/create/delete workflows)
- Both keys are already in `.env.local` -- add `N8N_MCP_TOKEN` to Vercel env vars when first serverless route calls n8n
- n8n's cloud-hosted plan includes TLS and handles webhook secrets internally

---

## Current env var status

| Var | .env.local | Vercel |
|-----|-----------|--------|
| N8N_API_KEY | present | not yet added |
| N8N_MCP_TOKEN | present | not yet added |
| N8N_MCP_URL | present | not yet added |

Add all three to Vercel env vars when first n8n-calling route ships.
