-- Add RLS policy to allow authenticated users to read agent_activity
create policy "auth users can read agent activity" on agent_activity 
for select to authenticated using (true);
