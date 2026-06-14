import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function test() {
  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-7-20250219",
      max_tokens: 100,
      messages: [{ role: "user", content: "Hello" }],
    });
    console.log("✅ Opus 4.7 is available");
    console.log(`Response:`, response.content[0]?.text?.substring(0, 100));
  } catch (error) {
    console.error("❌ Opus 4.7 not available or error:", error.message);
    console.log("\nTrying alternative model name...");
    try {
      const response2 = await anthropic.messages.create({
        model: "claude-opus-4-1-20250805",
        max_tokens: 100,
        messages: [{ role: "user", content: "Hello" }],
      });
      console.log("✅ Found: claude-opus-4-1-20250805");
    } catch (e2) {
      console.log("❌ No Opus variants found");
    }
  }
}

test();
