import { useState, useEffect } from 'react';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import type { Navigate } from '../App';

type LogEntry = { set_number: number; weight: number | null; reps: number; exercises: { name: string; muscle_group: string } };

export default function WorkoutSummary({ navigate, planId }: { navigate: Navigate; planId: string }) {
  const sb = getSupabaseSync();
  const [splitName, setSplitName] = useState('');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [{ data: plan }, { data: logData }] = await Promise.all([
        sb.from('workout_plans').select('split_name').eq('id', planId).single(),
        sb.from('workout_logs')
          .select('set_number, weight, reps, exercises(name, muscle_group)')
          .eq('workout_plan_id', planId)
          .order('exercise_id')
          .order('set_number'),
      ]);
      setSplitName(plan?.split_name || '');
      setLogs((logData || []) as any);
      setLoading(false);
    })();
  }, [planId]);

  if (loading) return <div className="loading"><div className="spinner" /></div>;

  const totalSets = logs.length;
  const totalReps = logs.reduce((s, l) => s + l.reps, 0);
  const totalVolume = logs.reduce((s, l) => s + (l.weight || 0) * l.reps, 0);
  const volDisplay = totalVolume >= 1000 ? `${(totalVolume / 1000).toFixed(1)}k` : String(totalVolume);

  const byExercise = new Map<string, LogEntry[]>();
  for (const log of logs) {
    const name = log.exercises?.name || 'Unknown';
    if (!byExercise.has(name)) byExercise.set(name, []);
    byExercise.get(name)!.push(log);
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 24, fontWeight: 800, textAlign: 'center', marginBottom: 4 }}>Workout Complete</h1>
      <p style={{ color: colors.textDim, textAlign: 'center', fontSize: 14, marginBottom: 24 }}>{splitName} Day</p>

      <div className="row" style={{ marginBottom: 24 }}>
        <div className="card flex-1" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{totalSets}</div>
          <div style={{ color: colors.textDim, fontSize: 11 }}>Sets</div>
        </div>
        <div className="card flex-1" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{totalReps}</div>
          <div style={{ color: colors.textDim, fontSize: 11 }}>Reps</div>
        </div>
        <div className="card flex-1" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{volDisplay}</div>
          <div style={{ color: colors.textDim, fontSize: 11 }}>Volume (lb)</div>
        </div>
      </div>

      {Array.from(byExercise.entries()).map(([name, sets]) => (
        <div key={name} className="card" style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{name}</span>
            <span style={{ color: colors.accent, fontSize: 11, fontWeight: 600 }}>
              {sets[0].exercises?.muscle_group}
            </span>
          </div>
          {sets.map(s => (
            <div key={s.set_number} style={{ color: colors.textDim, fontSize: 12, marginBottom: 2 }}>
              Set {s.set_number}: {s.weight ? `${s.weight} lb × ` : ''}{s.reps} reps
            </div>
          ))}
        </div>
      ))}

      <button className="btn-primary" style={{ marginTop: 16 }} onClick={() => navigate('today')}>Done</button>
    </div>
  );
}
