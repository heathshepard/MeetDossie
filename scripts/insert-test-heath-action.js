const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function insertTestAction() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Get Heath's user_id
  const { data: user } = await supabase
    .from("auth.users")
    .select("id")
    .eq("email", "heath.shepard@kw.com")
    .single();

  if (!user) {
    console.error("Heath user not found");
    process.exit(1);
  }

  const testAction = {
    tenant_id: user.id,
    title: "Test approve-send flow",
    body: "This is a test of the approve-and-send email workflow. If you see this, the full pipeline works end-to-end.",
    source: "carter_7",
    priority: "high",
    status: "pending",
    action_type: "send_email",
    recipient_email: "heath.shepard@kw.com",
    subject: "Heath actions approve-send test 2026-06-23",
  };

  const { data, error } = await supabase
    .from("heath_actions")
    .insert(testAction)
    .select("id");

  if (error) {
    console.error("Insert failed:", error);
    process.exit(1);
  }

  console.log("Test action created:");
  console.log("  ID:", data[0].id);
  console.log("  Recipient:", testAction.recipient_email);
  console.log("  Subject:", testAction.subject);
  console.log("  Status:", testAction.status);
}

insertTestAction().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
