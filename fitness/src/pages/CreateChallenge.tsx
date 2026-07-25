import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import { CHALLENGE_TYPES } from '../constants/challenges';
import type { Navigate } from '../App';

export default function CreateChallenge({ navigate }: { navigate: Navigate }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const sb = getSupabaseSync();

  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [partnerEmail, setPartnerEmail] = useState('');
  const [stakes, setStakes] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!selectedType) return;
    setError('');
    setCreating(true);

    const type = CHALLENGE_TYPES.find(t => t.key === selectedType)!;
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    let partnerId: string | null = null;
    if (partnerEmail.trim()) {
      const { data } = await sb.rpc('get_user_by_email', { lookup_email: partnerEmail.trim() });
      if (!data || data.length === 0) {
        setError('No user found with that email');
        setCreating(false);
        return;
      }
      partnerId = data[0].id;
      if (partnerId === userId) {
        setError("You can't challenge yourself");
        setCreating(false);
        return;
      }
    }

    const { data: challenge, error: insertErr } = await sb
      .from('challenges')
      .insert({
        creator_id: userId,
        challenge_type: selectedType,
        title: type.title,
        description: type.description,
        stakes: stakes.trim() || null,
        week_start: monday.toISOString().split('T')[0],
        week_end: sunday.toISOString().split('T')[0],
        status: 'active',
      })
      .select('id')
      .single();

    if (insertErr || !challenge) {
      setError('Failed to create challenge');
      setCreating(false);
      return;
    }

    const participants = [{ challenge_id: challenge.id, user_id: userId, status: 'accepted', score: 0 }];
    if (partnerId) {
      participants.push({ challenge_id: challenge.id, user_id: partnerId, status: 'pending', score: 0 });
    }
    await sb.from('challenge_participants').insert(participants);

    setCreating(false);
    navigate('challenges');
  };

  return (
    <div className="page">
      <div className="header">
        <button className="back-btn" onClick={() => navigate('challenges')}>‹ Back</button>
        <h1>New Challenge</h1>
      </div>

      <div className="text-label" style={{ marginBottom: 8 }}>Choose a challenge</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
        {CHALLENGE_TYPES.map(t => (
          <button
            key={t.key}
            className="card"
            onClick={() => setSelectedType(t.key)}
            style={{
              textAlign: 'left',
              display: 'flex', alignItems: 'center', gap: 12,
              borderColor: selectedType === t.key ? colors.accent : colors.border,
            }}
          >
            <span style={{ fontSize: 20 }}>{t.icon}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</div>
              <div style={{ color: colors.textDim, fontSize: 12 }}>{t.description}</div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className="text-label" style={{ marginBottom: 8 }}>Partner email (optional)</div>
        <input
          className="input"
          type="email"
          placeholder="partner@example.com"
          value={partnerEmail}
          onChange={e => setPartnerEmail(e.target.value)}
        />
      </div>

      <div style={{ marginBottom: 24 }}>
        <div className="text-label" style={{ marginBottom: 8 }}>Stakes (optional)</div>
        <input
          className="input"
          placeholder="Loser buys dinner"
          value={stakes}
          onChange={e => setStakes(e.target.value)}
        />
      </div>

      {error && <p className="error-text" style={{ marginBottom: 8 }}>{error}</p>}

      <button className="btn-primary" onClick={create} disabled={!selectedType || creating}>
        {creating ? 'Creating...' : 'Start Challenge'}
      </button>
    </div>
  );
}
