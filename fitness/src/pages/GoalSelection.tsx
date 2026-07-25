import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import { GOALS } from '../constants/goals';
import type { Navigate } from '../App';

export default function GoalSelection({ navigate }: { navigate: Navigate }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const sb = getSupabaseSync();

  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('profiles').select('goal').eq('id', userId).single();
      if (data?.goal) setSelected(data.goal);
    })();
  }, []);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    await sb.from('profiles').update({ goal: selected }).eq('id', userId);
    setSaving(false);
    navigate('today');
  };

  return (
    <div className="page">
      <div className="header">
        <button className="back-btn" onClick={() => navigate('today')}>‹ Back</button>
        <h1>Your Goal</h1>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {GOALS.map(g => (
          <button
            key={g.key}
            className="card"
            onClick={() => setSelected(g.key)}
            style={{
              textAlign: 'left',
              borderColor: selected === g.key ? colors.accent : colors.border,
              borderWidth: selected === g.key ? 2 : 1,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{g.title}</div>
            <div style={{ color: colors.textDim, fontSize: 13 }}>{g.description}</div>
          </button>
        ))}
      </div>

      <button className="btn-primary" onClick={save} disabled={!selected || saving}>
        {saving ? 'Saving...' : 'Continue'}
      </button>
    </div>
  );
}
