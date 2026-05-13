// API endpoint to generate Morning Brief script using Claude
// Takes urgent items and returns a natural conversational script

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { userFirstName, urgentItems } = req.body;

  if (!userFirstName || !urgentItems) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Build context from urgent items
    const itemsContext = urgentItems.map((item, idx) => {
      const actionItems = item.actionItems || [];
      const escalatedItems = actionItems.filter(a => String(a.status).toLowerCase() === 'escalated');
      const overdueItems = actionItems.filter(a => String(a.status).toLowerCase() === 'overdue');

      return `Item ${idx + 1}:
- Client: ${item.clientName}
- Property: ${item.shortAddress}
- Closing: ${item.closingDays >= 0 ? `${item.closingDays} days` : 'not set'}
- Escalated: ${escalatedItems.map(a => `${a.description} (${a.follow_up_count || 0} follow-ups sent)`).join('; ')}
- Overdue: ${overdueItems.map(a => a.description).join('; ')}`;
    }).join('\n\n');

    const prompt = `You are Dossie, a transaction coordinator AI assistant. Write a natural, conversational Morning Brief script for ${userFirstName}.

URGENT ITEMS:
${itemsContext}

INSTRUCTIONS:
- Write as Dossie speaking directly to ${userFirstName}
- Start with: "Good morning ${userFirstName}."
- Be conversational and warm, not robotic
- Make action ownership clear (what Sarah needs to do vs what you've been handling)
- For escalated items with follow-ups: "I've been following up on [task] but haven't heard back. This one needs your direct attention."
- For overdue items: "You need to [task]."
- Lead with most urgent first (closing soon, then escalated, then overdue)
- Use client name + property format: "Olivia Park at Cibolo Vista"
- Keep under 50 seconds when spoken (about 150 words max)
- End with exactly these two lines: "Everything else is moving cleanly. Your deals are in good hands." Then: "I've got you covered."

Write ONLY the script text that Luna will read. No explanations, no meta-commentary.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Claude API error:', response.status, error);
      return res.status(500).json({ error: 'Failed to generate script' });
    }

    const data = await response.json();
    const script = data.content[0].text;

    return res.status(200).json({ script });

  } catch (error) {
    console.error('Error generating brief script:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
