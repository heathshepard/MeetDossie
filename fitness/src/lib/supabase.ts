import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export async function getSupabase(): Promise<SupabaseClient> {
  if (_client) return _client;
  const res = await fetch('/api/fitness-config');
  const { supabaseUrl, supabaseKey } = await res.json();
  _client = createClient(supabaseUrl, supabaseKey);
  return _client;
}

export function getSupabaseSync(): SupabaseClient {
  if (!_client) throw new Error('Supabase not initialized');
  return _client;
}
