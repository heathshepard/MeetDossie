import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import { GOALS } from '../constants/goals';
import { getTodaySplit, generateWorkout, type PlannedExercise } from '../lib/workout-generator';
import { computeRecovery, type MuscleRecovery } from '../lib/recovery';
import type { GoalKey } from '../constants/goals';
import type { Navigate } from '../App';

export default function Today({ navigate }: { navigate: Navigate }) {
  const { session, signOut } = useAuth();
  const userId = session?.user.id;
  const sb = getSupabaseSync();

  const [equipCount, setEquipCount] = useState<number>(0);
  const [goal, setGoal] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<{ id: string; split_name: string; exercises: PlannedExercise[]; status: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [recovery, setRecovery] = useState<MuscleRecovery[]>([]);
  const [challengeCount, setChallengeCount] = useState(0);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);

    const [{ count }, { data: profile }, { data: existingPlan }] = await Promise.all([
      sb.from('equipment_items').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      sb.from('profiles').select('goal, created_at').eq('id', userId).single(),
      sb.from('workout_plans')
        .select('id, split_name, exercises, status')
        .eq('user_id', userId)
        .eq('plan_date', new Date().toISOString().split('T')[0])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    setEquipCount(count ?? 0);
    setGoal(profile?.goal ?? null);
    setPlan(existingPlan as any);

    const { data: recentLogs } = await sb
      .from('workout_logs')
      .select('logged_at, exercises(muscle_group)')
      .eq('user_id', userId)
      .order('logged_at', { ascending: false })
      .limit(200);

    const lastWorked: Record<string, string> = {};
    for (const log of (recentLogs || []) as any[]) {
      const group = log.exercises?.muscle_group;
      if (group && !lastWorked[group]) lastWorked[group] = log.logged_at;
    }
    setRecovery(computeRecovery(lastWorked));

    const { count: cc } = await sb
      .from('challenge_participants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['accepted', 'pending']);
    setChallengeCount(cc ?? 0);

    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    if (!userId || !goal) return;
    setGenerating(true);

    const [{ data: equipment }, { data: exercises }] = await Promise.all([
      sb.from('equipment_items').select('name, config').eq('user_id', userId),
      sb.from('exercises').select('id, name, muscle_group, equipment_needed, is_compound'),
    ]);

    const { data: profile } = await sb.from('profiles').select('created_at').eq('id', userId).single();
    const split = getTodaySplit(profile?.created_at || new Date().toISOString());
    const planned = generateWorkout(goal as GoalKey, split, exercises || [], equipment || []);

    const { data: newPlan } = await sb
      .from('workout_plans')
      .insert({
        user_id: userId,
        plan_date: new Date().toISOString().split('T')[0],
        split_name: split.name,
        exercises: planned,
        status: 'pending',
      })
      .select('id, split_name, exercises, status')
      .single();

    if (newPlan) setPlan(newPlan as any);
    setGenerating(false);
  };

  const goalTitle = GOALS.find(g => g.key === goal)?.title;

  if (loading) {
    return <div className="loading"><div className="spinner" /></div>;
  }

  const needsSetup = equipCount === 0 || !goal;

  return (
    <div className="page">
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 16 }}>Today</h1>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="card flex-1" onClick={() => navigate('equipment')} style={{ textAlign: 'left' }}>
          <span className="text-label">Equipment</span>
          <div style={{ color: colors.text, fontSize: 15, fontWeight: 700, marginTop: 2 }}>
            {equipCount} item{equipCount === 1 ? '' : 's'}
          </div>
        </button>
        <button className="card flex-1" onClick={() => navigate('goals')} style={{ textAlign: 'left' }}>
          <span className="text-label">Goal</span>
          <div style={{ color: colors.text, fontSize: 15, fontWeight: 700, marginTop: 2 }}>
            {goalTitle ?? 'Not set'}
          </div>
        </button>
      </div>

      {recovery.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="text-label" style={{ marginBottom: 12 }}>Muscle Recovery</div>
          {recovery.map(m => (
            <div key={m.group} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, width: 72 }}>{m.label}</span>
              <div className="recovery-bar-bg">
                <div
                  className={`recovery-bar ${m.status === 'recovered' ? 'bar-recovered' : m.status === 'recovering' ? 'bar-recovering' : 'bar-sore'}`}
                  style={{ width: `${m.pct}%` }}
                />
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, width: 36, textAlign: 'right',
                color: m.status === 'recovered' ? colors.success : m.status === 'recovering' ? colors.warning : colors.critical,
              }}>{m.pct}%</span>
            </div>
          ))}
        </div>
      )}

      <button
        className="card"
        onClick={() => navigate('challenges')}
        style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', marginBottom: 16 }}
      >
        <span style={{ fontSize: 24 }}>🏆</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Challenges</div>
          <div style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>
            {challengeCount > 0 ? `${challengeCount} active` : 'Compete with a partner'}
          </div>
        </div>
        <span style={{ color: colors.textDim, fontSize: 20 }}>›</span>
      </button>

      {needsSetup ? (
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Set up to get started</div>
          <div style={{ color: colors.textDim, fontSize: 14, lineHeight: '20px' }}>
            Add your equipment and pick a goal to generate your first workout.
          </div>
        </div>
      ) : !plan ? (
        <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
          {generating ? 'Generating...' : "Generate Today's Workout"}
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800 }}>{plan.split_name} Day</div>
              <div style={{ color: colors.textDim, fontSize: 13, marginTop: 2 }}>{plan.exercises.length} exercises</div>
            </div>
            {plan.status === 'completed' ? (
              <span style={{ background: colors.success, color: '#fff', borderRadius: 12, padding: '6px 16px', fontSize: 13, fontWeight: 700 }}>Done</span>
            ) : (
              <button
                className="btn-primary"
                style={{ width: 'auto', padding: '8px 24px' }}
                onClick={() => navigate('workout', { planId: plan.id })}
              >
                {plan.status === 'in_progress' ? 'Resume' : 'Start'}
              </button>
            )}
          </div>

          {plan.exercises.map((ex, i) => (
            <div key={ex.exercise_id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
              <span style={{ color: colors.textDim, fontSize: 14, fontWeight: 700, width: 24, textAlign: 'center' }}>{i + 1}</span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{ex.name}</div>
                <div style={{ color: colors.textDim, fontSize: 12, marginTop: 2 }}>
                  {ex.sets} x {ex.reps}{ex.weight_display ? ` · ${ex.weight_display}` : ''}
                </div>
              </div>
            </div>
          ))}

          {plan.status !== 'completed' && (
            <button
              onClick={async () => {
                await sb.from('workout_plans').delete().eq('id', plan.id);
                setPlan(null);
              }}
              style={{ color: colors.textDim, fontSize: 13, width: '100%', textAlign: 'center', padding: 8, marginTop: 4 }}
            >
              Regenerate
            </button>
          )}
        </div>
      )}

      <button
        onClick={signOut}
        style={{ color: colors.textDim, fontSize: 13, width: '100%', textAlign: 'center', padding: 12, marginTop: 24 }}
      >
        Sign out
      </button>
    </div>
  );
}
