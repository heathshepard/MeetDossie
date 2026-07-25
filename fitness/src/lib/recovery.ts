const RECOVERY_HOURS: Record<string, number> = {
  chest: 48,
  shoulders: 48,
  triceps: 36,
  back: 72,
  biceps: 36,
  legs: 72,
  abs: 24,
};

const GROUP_LABELS: Record<string, string> = {
  chest: 'Chest',
  shoulders: 'Shoulders',
  triceps: 'Triceps',
  back: 'Back',
  biceps: 'Biceps',
  legs: 'Legs',
  abs: 'Core',
};

const ALL_GROUPS = ['chest', 'back', 'shoulders', 'legs', 'triceps', 'biceps', 'abs'];

export type MuscleRecovery = {
  group: string;
  label: string;
  pct: number;
  status: 'recovered' | 'recovering' | 'sore';
};

export function computeRecovery(
  lastWorked: Record<string, string>,
): MuscleRecovery[] {
  const now = Date.now();

  return ALL_GROUPS.map((group) => {
    const lastDate = lastWorked[group];
    if (!lastDate) {
      return { group, label: GROUP_LABELS[group], pct: 100, status: 'recovered' as const };
    }

    const elapsed = (now - new Date(lastDate).getTime()) / 3600000;
    const needed = RECOVERY_HOURS[group] || 48;
    const pct = Math.min(100, Math.round((elapsed / needed) * 100));

    let status: 'recovered' | 'recovering' | 'sore';
    if (pct >= 80) status = 'recovered';
    else if (pct >= 40) status = 'recovering';
    else status = 'sore';

    return { group, label: GROUP_LABELS[group], pct, status };
  });
}
