import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { getSupabaseSync } from '../lib/supabase';
import { colors } from '../lib/theme';
import type { PlannedExercise } from '../lib/workout-generator';
import type { Navigate } from '../App';

type SetLog = { exerciseIdx: number; set: number; weight: number | null; reps: number; logged: boolean };

export default function Workout({ navigate, planId }: { navigate: Navigate; planId: string }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const sb = getSupabaseSync();

  const [splitName, setSplitName] = useState('');
  const [exercises, setExercises] = useState<PlannedExercise[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [sets, setSets] = useState<SetLog[]>([]);
  const [restTime, setRestTime] = useState(0);
  const timerRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from('workout_plans').select('split_name, exercises').eq('id', planId).single();
      if (data) {
        setSplitName(data.split_name);
        const exs = data.exercises as PlannedExercise[];
        setExercises(exs);
        const allSets: SetLog[] = [];
        exs.forEach((ex, ei) => {
          for (let s = 1; s <= ex.sets; s++) {
            allSets.push({ exerciseIdx: ei, set: s, weight: ex.weight, reps: ex.reps, logged: false });
          }
        });
        setSets(allSets);
      }
      await sb.from('workout_plans').update({ status: 'in_progress' }).eq('id', planId);
      setLoading(false);
    })();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [planId]);

  const currentExercise = exercises[currentIdx];
  const currentSets = sets.filter(s => s.exerciseIdx === currentIdx);
  const totalSets = sets.length;
  const loggedSets = sets.filter(s => s.logged).length;

  const startRest = (seconds: number) => {
    setRestTime(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setRestTime(t => {
        if (t <= 1) { clearInterval(timerRef.current!); return 0; }
        return t - 1;
      });
    }, 1000);
  };

  const logSet = (setIdx: number) => {
    setSets(s => s.map((x, i) => i === setIdx ? { ...x, logged: true } : x));
    if (currentExercise) startRest(currentExercise.rest_seconds);
  };

  const adjustWeight = (globalIdx: number, delta: number) => {
    setSets(s => s.map((x, i) => i === globalIdx ? { ...x, weight: Math.max(0, (x.weight || 0) + delta) } : x));
  };

  const adjustReps = (globalIdx: number, delta: number) => {
    setSets(s => s.map((x, i) => i === globalIdx ? { ...x, reps: Math.max(1, x.reps + delta) } : x));
  };

  const finishWorkout = async () => {
    const loggedEntries = sets.filter(s => s.logged);
    if (loggedEntries.length > 0) {
      const rows = loggedEntries.map(s => ({
        user_id: userId,
        workout_plan_id: planId,
        exercise_id: exercises[s.exerciseIdx].exercise_id,
        set_number: s.set,
        weight: s.weight,
        reps: s.reps,
      }));
      await sb.from('workout_logs').insert(rows);
    }
    await sb.from('workout_plans').update({ status: 'completed' }).eq('id', planId);
    navigate('summary', { planId });
  };

  if (loading || !currentExercise) {
    return <div className="loading"><div className="spinner" /></div>;
  }

  const globalOffset = sets.findIndex(s => s.exerciseIdx === currentIdx);

  return (
    <div className="page" style={{ paddingBottom: 40 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button className="back-btn" onClick={() => navigate('today')}>‹ Back</button>
        <span style={{ fontSize: 15, fontWeight: 700 }}>{splitName} Day</span>
        <span style={{ color: colors.textDim, fontSize: 13 }}>{loggedSets}/{totalSets}</span>
      </div>

      {restTime > 0 && (
        <div style={{ background: colors.accent, color: colors.accentText, borderRadius: 12, padding: 12, textAlign: 'center', marginBottom: 12, fontWeight: 700 }}>
          Rest: {restTime}s
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginBottom: 20 }}>
        {exercises.map((_, i) => {
          const done = sets.filter(s => s.exerciseIdx === i).every(s => s.logged);
          return (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              style={{
                width: 28, height: 28, borderRadius: 14, fontSize: 12, fontWeight: 700,
                background: i === currentIdx ? colors.accent : done ? colors.success : colors.surface2,
                color: i === currentIdx ? colors.accentText : done ? '#fff' : colors.textDim,
                border: 'none',
              }}
            >{i + 1}</button>
          );
        })}
      </div>

      <div style={{ textAlign: 'center', marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{currentExercise.name}</div>
        <div style={{ color: colors.textDim, fontSize: 12, marginTop: 4 }}>
          {currentExercise.muscle_group} · {currentExercise.weight_display || 'Bodyweight'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {currentSets.map((s, i) => {
          const gi = globalOffset + i;
          return (
            <div key={i} className="card" style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: s.logged ? 0.5 : 1 }}>
              <span style={{ color: colors.textDim, fontSize: 13, fontWeight: 700, width: 40 }}>Set {s.set}</span>

              {s.weight !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                  <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => adjustWeight(gi, -5)} disabled={s.logged}>−</button>
                  <span style={{ fontSize: 13, fontWeight: 600, minWidth: 44, textAlign: 'center' }}>{s.weight} lb</span>
                  <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => adjustWeight(gi, 5)} disabled={s.logged}>+</button>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => adjustReps(gi, -1)} disabled={s.logged}>−</button>
                <span style={{ fontSize: 13, fontWeight: 600, minWidth: 28, textAlign: 'center' }}>{s.reps}</span>
                <button className="btn-secondary" style={{ padding: '4px 8px', fontSize: 12 }} onClick={() => adjustReps(gi, 1)} disabled={s.logged}>+</button>
              </div>

              <button
                onClick={() => logSet(gi)}
                disabled={s.logged}
                style={{
                  background: s.logged ? colors.success : colors.accent,
                  color: s.logged ? '#fff' : colors.accentText,
                  borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700,
                }}
              >{s.logged ? '✓' : 'Log'}</button>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 20 }}>
        {currentIdx < exercises.length - 1 ? (
          <button className="btn-primary" onClick={() => setCurrentIdx(currentIdx + 1)}>Next Exercise</button>
        ) : (
          <button className="btn-primary" onClick={finishWorkout}>Finish Workout</button>
        )}
      </div>
    </div>
  );
}
