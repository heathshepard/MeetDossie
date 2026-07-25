import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import { CHALLENGE_TYPES } from '../constants/challenges';
import type { Navigate } from '../App';

type Participant = { user_id: string; status: string; score: number };
type Challenge = {
  id: string; challenge_type: string; title: string; description: string;
  stakes: string | null; week_start: string; week_end: string; status: string;
  challenge_participants: Participant[];
};

export default function Challenges({ navigate }: { navigate: Navigate }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const sb = getSupabaseSync();

  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb
        .from('challenges')
        .select('id, challenge_type, title, description, stakes, week_start, week_end, status, challenge_participants(user_id, status, score)')
        .order('created_at', { ascending: false });

      const all = (data || []) as Challenge[];
      const mine = all.filter(c => c.challenge_participants.some(p => p.user_id === userId));
      setChallenges(mine);

      const userIds = [...new Set(mine.flatMap(c => c.challenge_participants.map(p => p.user_id)))];
      if (userIds.length > 0) {
        const { data: profiles } = await sb.from('profiles').select('id, display_name').in('id', userIds);
        const map: Record<string, string> = {};
        for (const p of (profiles || [])) map[p.id] = p.display_name || 'Unknown';
        setNames(map);
      }
      setLoading(false);
    })();
  }, []);

  const respond = async (challengeId: string, status: 'accepted' | 'declined') => {
    await sb.from('challenge_participants').update({ status }).eq('challenge_id', challengeId).eq('user_id', userId);
    setChallenges(cs => cs.map(c =>
      c.id === challengeId
        ? { ...c, challenge_participants: c.challenge_participants.map(p => p.user_id === userId ? { ...p, status } : p) }
        : c
    ));
  };

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  const pending = challenges.filter(c => c.challenge_participants.some(p => p.user_id === userId && p.status === 'pending'));
  const active = challenges.filter(c => c.status === 'active' && c.challenge_participants.some(p => p.user_id === userId && p.status === 'accepted'));
  const completed = challenges.filter(c => c.status === 'completed');

  const renderChallenge = (c: Challenge, showActions = false) => {
    const type = CHALLENGE_TYPES.find(t => t.key === c.challenge_type);
    const sorted = [...c.challenge_participants].filter(p => p.status === 'accepted').sort((a, b) => b.score - a.score);

    return (
      <div key={c.id} className="card" style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 20 }}>{type?.icon || '🏆'}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{c.title}</div>
            <div style={{ color: colors.textDim, fontSize: 12 }}>{c.description}</div>
          </div>
        </div>
        {c.stakes && (
          <div style={{ color: colors.warning, fontSize: 12, marginBottom: 8 }}>Stakes: {c.stakes}</div>
        )}
        <div style={{ color: colors.textDim, fontSize: 11, marginBottom: 8 }}>
          {c.week_start} → {c.week_end}
        </div>
        {sorted.map((p, i) => (
          <div key={p.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ color: colors.textDim, fontSize: 12, width: 20 }}>#{i + 1}</span>
            <span style={{ fontSize: 13, flex: 1 }}>{p.user_id === userId ? 'You' : names[p.user_id] || 'Partner'}</span>
            <span style={{ color: colors.accent, fontSize: 13, fontWeight: 700 }}>{p.score} {type?.unit || ''}</span>
          </div>
        ))}
        {showActions && (
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn-primary flex-1" style={{ padding: 10, fontSize: 14 }} onClick={() => respond(c.id, 'accepted')}>Accept</button>
            <button className="btn-secondary flex-1" onClick={() => respond(c.id, 'declined')}>Decline</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="page">
      <div className="header">
        <button className="back-btn" onClick={() => navigate('today')}>‹ Back</button>
        <h1 style={{ flex: 1 }}>Challenges</h1>
        <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => navigate('createChallenge')}>+ New</button>
      </div>

      {pending.length > 0 && (
        <>
          <div className="text-label" style={{ marginBottom: 8 }}>Pending Invites</div>
          {pending.map(c => renderChallenge(c, true))}
        </>
      )}

      {active.length > 0 && (
        <>
          <div className="text-label" style={{ marginBottom: 8, marginTop: 16 }}>Active</div>
          {active.map(c => renderChallenge(c))}
        </>
      )}

      {completed.length > 0 && (
        <>
          <div className="text-label" style={{ marginBottom: 8, marginTop: 16 }}>Completed</div>
          {completed.map(c => renderChallenge(c))}
        </>
      )}

      {challenges.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 24, color: colors.textDim }}>
          No challenges yet. Start one with a partner!
        </div>
      )}
    </div>
  );
}
