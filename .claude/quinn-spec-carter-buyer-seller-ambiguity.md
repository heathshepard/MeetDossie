# Quinn -> Carter: Buyer vs Seller non-determinism — CRITICAL

**Severity:** CRITICAL — produces contracts with WRONG party on each side.

## Bug

Same exact natural-language input to `/api/extract-form-fields` produces DIFFERENT `buyer_name` / `seller_name` assignments across runs. The Haiku LLM is non-deterministic on role assignment.

## Reproduction

Request payload (identical, twice):
```json
{
  "form_type": "resale-contract",
  "message": "Make an offer at 789 Maple St for the Garcia family, $250k purchase price, FHA 3.5% down, 15-day option, close August 1st"
}
```

**Run 1 response (F3):**
```json
"field_values": {
  "seller_name": "Garcia family",
  "buyer_name": undefined,
  "sale_price": 250000, ...
}
```

**Run 2 response (R1):**
```json
"field_values": {
  "buyer_name": "Garcia family",
  "seller_name": undefined,
  "sale_price": 250000, ...
}
```

## Why this is a 5/5 belief-killer

The agent voices: "Make an offer FOR the Garcia family." Buyer-side agents say "for" to indicate the BUYER they represent. Putting Garcia on the SELLER line means:

- The TREC 20-19 PDF will have Garcia in the Seller signature block
- The buyer-side agent's client signs as Seller (legally meaningless)
- The actual buyer (Garcia) is not represented
- The actual seller (whoever owns 789 Maple) gets a contract naming someone else as seller

**This is not just a UX bug — it's a contract integrity failure.** Filing this PDF with a title company or the brokerage compliance system invites E&O claims.

A single instance of this happening to Brittney destroys all trust.

## Root cause

The current `extract-form-fields.js` prompt (line 359) treats buyer / seller as freely-extractable strings with no role disambiguation:

> "Extract these fields from the agent's message and transaction context.
> - buyer_name (string): Full legal name(s) of buyer(s).
> - seller_name (string): Full legal name(s) of seller(s)."

When the message says "offer FOR the Garcia family," the LLM has no signal whether:
- "for" = "on behalf of" (Garcia is buyer; agent is buyer-side)
- "for" = "to" (Garcia is seller; agent is buyer-side making an offer TO them)

In English both readings are valid. The LLM picks randomly.

## Fix

### A. Pass agent role explicitly

In the React dispatcher (after Bug 2 dispatcher fix lands), when calling `extract-form-fields`, include the agent's role for the transaction:

```js
const txContext = {
  ...existingTxData,
  agent_role: dossier.role || 'buyer', // 'buyer' | 'seller' | 'both'
};
```

If no dossier is active yet (new fill), derive from the message keywords:
- "make an offer", "purchasing", "buying", "buyer rep" → agent_role = "buyer"
- "listing", "selling for", "seller's side", "ERTL" → agent_role = "seller"
- ambiguous → ask the agent first

### B. Strengthen the prompt with role-anchored rules

Replace current `buyer_name` / `seller_name` schema text with:

```
You are extracting party names. CRITICAL: The agent represents ONE side. The
"agent_role" field in the transaction context tells you which side.

If agent_role == "buyer":
  - The PARTY THE AGENT REPRESENTS is the buyer.
  - In the message, the buyer is typically named with "for", "buying",
    "purchasing", "buyer is", "client", "my buyer", "the buyers".
  - The seller is the OTHER party — typically named with "from", "owned by",
    "listed by", "sellers are", or the property's owner. If the message
    doesn't name the seller, leave seller_name empty.

If agent_role == "seller":
  - The PARTY THE AGENT REPRESENTS is the seller.
  - The buyer is the OTHER party — the offeror, typically named with "from",
    "offer from", "buyer is", "they're buying".
  - The seller is the AGENT'S client.

If agent_role is missing, treat as "buyer" by default (most common case for
"make an offer"). Output buyer_name only; leave seller_name empty unless
the message explicitly names the seller.
```

### C. Validate before fill-form

In `api/fill-form.js`, before generating the PDF:
- If `transaction.role == 'buyer'` and `buyer_name` is empty but `seller_name` is set, **return 400 with a clear error**: "Buyer name is required for buyer-side contract. The party you named appears to be the seller — please re-state which client is the buyer."
- Symmetric check for seller-side.

This catches the bug before a bad PDF is generated.

### D. Test for determinism

Add an integration test that hits `extract-form-fields` 5x with the same payload and asserts:
- Same `buyer_name` value across all 5 (deterministic on role)
- `buyer_name` matches the agent_role's party

## How to verify

After deploy:
```bash
for i in 1 2 3 4 5; do
  curl -X POST https://meetdossie.com/api/extract-form-fields \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d '{"form_type":"resale-contract","message":"Make an offer at 789 Maple St for the Garcia family, $250k, FHA 3.5% down","transaction":{"agent_role":"buyer"}}' \
  | jq '.field_values | {buyer_name, seller_name}'
done
```

Expect 5x identical results: `{"buyer_name": "Garcia family", "seller_name": null}`.

## Sequencing

Carter — work this AFTER specs 1 & 2 (which restore the basic flow). Otherwise this fix is invisible.

## Why this matters

Three of Heath's first 12 founding members (Brittney, Miki, Natalie) are agents who do their own contracts. If Dossie names their buyer as the seller on the TREC 20, they catch it before sending and lose all trust. If they don't catch it — disaster.

This is a "would I be embarrassed to demo this to Brittney" failure. Today, the answer is yes. Fix this and the answer flips.
