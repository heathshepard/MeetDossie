import type { GoalKey } from '../constants/goals';

export type PlannedExercise = {
  exercise_id: string;
  name: string;
  muscle_group: string;
  sets: number;
  reps: number;
  weight: number | null;
  weight_display: string | null;
  rest_seconds: number;
};

type EquipmentItem = {
  name: string;
  config: Record<string, any>;
};

type Exercise = {
  id: string;
  name: string;
  muscle_group: string;
  equipment_needed: string[];
  is_compound: boolean;
};

const SPLITS = [
  { name: 'Push', groups: ['chest', 'shoulders', 'triceps'] },
  { name: 'Pull', groups: ['back', 'biceps'] },
  { name: 'Legs & Core', groups: ['legs', 'abs'] },
];

const VOLUME: Record<string, Record<GoalKey, Record<string, number>>> = {
  Push: {
    slim_down:         { chest: 3, shoulders: 2, triceps: 2 },
    tone_up:           { chest: 3, shoulders: 2, triceps: 2 },
    bulk_up:           { chest: 3, shoulders: 2, triceps: 2 },
    strength_training: { chest: 2, shoulders: 2, triceps: 1 },
  },
  Pull: {
    slim_down:         { back: 3, biceps: 3 },
    tone_up:           { back: 3, biceps: 3 },
    bulk_up:           { back: 4, biceps: 3 },
    strength_training: { back: 3, biceps: 2 },
  },
  'Legs & Core': {
    slim_down:         { legs: 4, abs: 3 },
    tone_up:           { legs: 4, abs: 3 },
    bulk_up:           { legs: 5, abs: 2 },
    strength_training: { legs: 4, abs: 2 },
  },
};

const GOAL_PARAMS: Record<GoalKey, {
  compound: { sets: number; reps: number; restSec: number; intensityPct: number };
  isolation: { sets: number; reps: number; restSec: number; intensityPct: number };
}> = {
  slim_down: {
    compound:  { sets: 3, reps: 15, restSec: 45,  intensityPct: 0.55 },
    isolation: { sets: 3, reps: 15, restSec: 30,  intensityPct: 0.50 },
  },
  tone_up: {
    compound:  { sets: 3, reps: 12, restSec: 60,  intensityPct: 0.65 },
    isolation: { sets: 3, reps: 12, restSec: 45,  intensityPct: 0.60 },
  },
  bulk_up: {
    compound:  { sets: 4, reps: 8,  restSec: 90,  intensityPct: 0.75 },
    isolation: { sets: 3, reps: 12, restSec: 60,  intensityPct: 0.65 },
  },
  strength_training: {
    compound:  { sets: 5, reps: 5,  restSec: 180, intensityPct: 0.85 },
    isolation: { sets: 3, reps: 10, restSec: 90,  intensityPct: 0.65 },
  },
};

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function getTodaySplit(startDate: string): typeof SPLITS[number] {
  const start = new Date(startDate);
  const today = new Date();
  const diffDays = Math.floor((today.getTime() - start.getTime()) / 86400000);
  return SPLITS[((diffDays % SPLITS.length) + SPLITS.length) % SPLITS.length];
}

function userHasEquipment(needed: string[], userEquipNames: Set<string>): boolean {
  if (needed.length === 0) return true;
  return needed.every((e) => userEquipNames.has(e));
}

function roundToIncrement(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

function computeWeight(
  exerciseName: string,
  intensityPct: number,
  equipmentMap: Map<string, EquipmentItem>,
): { weight: number | null; display: string | null } {
  const lower = exerciseName.toLowerCase();

  if (lower.includes('push-up') || lower.includes('pull-up') || lower.includes('chin-up') ||
      lower.includes('dip') || lower.includes('plank') || lower.includes('hanging') ||
      lower.includes('dead bug') || lower.includes('mountain climber') || lower.includes('bicycle') ||
      lower.includes('side plank') || lower.includes('superman') || lower.includes('inverted row') ||
      lower.includes('bodyweight') || lower.includes('russian twist') || lower.includes('calf raise')) {
    return { weight: null, display: 'Bodyweight' };
  }

  if (lower.includes('resistance band')) {
    return { weight: null, display: 'Band' };
  }

  if (lower.includes('barbell') || lower.includes('romanian deadlift') ||
      lower.includes('t-bar row') || lower.includes('close-grip bench') || lower.includes('front squat')) {
    const barbell = equipmentMap.get('Barbell');
    if (!barbell?.config?.bar_weight || !barbell?.config?.plates?.length) {
      return { weight: null, display: null };
    }
    const barWeight = barbell.config.bar_weight as number;
    const plates = (barbell.config.plates as number[]).sort((a, b) => b - a);
    const estimatedMax = barWeight + plates[0] * 2 * 2;
    const target = estimatedMax * intensityPct;
    const perSide = (target - barWeight) / 2;

    let remaining = Math.max(0, perSide);
    const usedPlates: number[] = [];
    for (const plate of plates) {
      while (remaining >= plate - 0.01) {
        usedPlates.push(plate);
        remaining -= plate;
      }
    }
    const actualWeight = barWeight + usedPlates.reduce((s, p) => s + p, 0) * 2;
    const plateStr = usedPlates.length > 0 ? usedPlates.join(' + ') + ' per side' : 'bar only';
    return { weight: actualWeight, display: `${actualWeight} lb (${plateStr})` };
  }

  if (lower.includes('ez bar') || lower.includes('skull crusher')) {
    const barbell = equipmentMap.get('Barbell');
    if (!barbell?.config?.bar_weight || !barbell?.config?.plates?.length) {
      return { weight: null, display: null };
    }
    const barWeight = 25;
    const plates = (barbell.config.plates as number[]).sort((a, b) => b - a);
    const estimatedMax = barWeight + plates[0] * 2;
    const target = estimatedMax * intensityPct;
    const perSide = (target - barWeight) / 2;

    let remaining = Math.max(0, perSide);
    const usedPlates: number[] = [];
    for (const plate of plates) {
      while (remaining >= plate - 0.01) {
        usedPlates.push(plate);
        remaining -= plate;
      }
    }
    const actualWeight = barWeight + usedPlates.reduce((s, p) => s + p, 0) * 2;
    return { weight: actualWeight, display: `${actualWeight} lb` };
  }

  if (lower.includes('dumbbell') || lower.includes('goblet') || lower.includes('kettlebell') ||
      lower.includes('arnold') || lower.includes('hammer curl') || lower.includes('concentration') ||
      lower.includes('kickback') || lower.includes('walking lunge') || lower.includes('renegade')) {
    const equip = equipmentMap.get('Dumbbells') || equipmentMap.get('Kettlebells');
    if (!equip?.config?.max) return { weight: null, display: null };
    const max = equip.config.max as number;
    const increment = (equip.config.increment as number) || 5;
    const min = (equip.config.min as number) || 5;
    const target = max * intensityPct;
    const rounded = roundToIncrement(Math.max(min, target), increment);
    return { weight: rounded, display: `${rounded} lb each` };
  }

  if (lower.includes('cable') || lower.includes('lat pulldown') || lower.includes('leg press') ||
      lower.includes('straight-arm') || lower.includes('face pull')) {
    const machines = ['Cable Machine', 'Lat Pulldown', 'Leg Press'];
    let equip: EquipmentItem | undefined;
    for (const m of machines) {
      if (equipmentMap.has(m)) { equip = equipmentMap.get(m); break; }
    }
    if (!equip?.config?.max) return { weight: null, display: null };
    const max = equip.config.max as number;
    const increment = (equip.config.increment as number) || 10;
    const min = (equip.config.min as number) || 10;
    const target = max * intensityPct;
    const rounded = roundToIncrement(Math.max(min, target), increment);
    return { weight: rounded, display: `${rounded} lb` };
  }

  if (lower.includes('smith machine')) {
    const sm = equipmentMap.get('Smith Machine');
    if (!sm?.config?.max) return { weight: null, display: null };
    const max = sm.config.max as number;
    const increment = (sm.config.increment as number) || 10;
    const min = (sm.config.min as number) || 20;
    const target = max * intensityPct;
    const rounded = roundToIncrement(Math.max(min, target), increment);
    return { weight: rounded, display: `${rounded} lb` };
  }

  return { weight: null, display: null };
}

export function generateWorkout(
  goal: GoalKey,
  split: typeof SPLITS[number],
  exercises: Exercise[],
  equipment: EquipmentItem[],
): PlannedExercise[] {
  const params = GOAL_PARAMS[goal];
  const equipNames = new Set(equipment.map((e) => e.name));
  const equipMap = new Map(equipment.map((e) => [e.name, e]));
  const targets = VOLUME[split.name]?.[goal] || {};

  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

  const available = exercises.filter(
    (ex) => split.groups.includes(ex.muscle_group) && userHasEquipment(ex.equipment_needed, equipNames),
  );

  const byGroup = new Map<string, { compounds: Exercise[]; isolations: Exercise[] }>();
  for (const ex of available) {
    if (!byGroup.has(ex.muscle_group)) {
      byGroup.set(ex.muscle_group, { compounds: [], isolations: [] });
    }
    const group = byGroup.get(ex.muscle_group)!;
    if (ex.is_compound) {
      group.compounds.push(ex);
    } else {
      group.isolations.push(ex);
    }
  }

  const selected: { exercise: Exercise; isCompound: boolean; groupOrder: number }[] = [];

  for (let gi = 0; gi < split.groups.length; gi++) {
    const group = split.groups[gi];
    const target = targets[group] || 3;
    const pool = byGroup.get(group) || { compounds: [], isolations: [] };

    const shuffledCompounds = seededShuffle(pool.compounds, seed + gi * 137);
    const shuffledIsolations = seededShuffle(pool.isolations, seed + gi * 251);

    let picked = 0;

    for (const ex of shuffledCompounds) {
      if (picked >= target) break;
      selected.push({ exercise: ex, isCompound: true, groupOrder: gi });
      picked++;
    }

    for (const ex of shuffledIsolations) {
      if (picked >= target) break;
      selected.push({ exercise: ex, isCompound: false, groupOrder: gi });
      picked++;
    }
  }

  selected.sort((a, b) => {
    if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
    if (a.isCompound !== b.isCompound) return a.isCompound ? -1 : 1;
    return 0;
  });

  return selected.map(({ exercise, isCompound }) => {
    const p = isCompound ? params.compound : params.isolation;
    const { weight, display } = computeWeight(exercise.name, p.intensityPct, equipMap);
    return {
      exercise_id: exercise.id,
      name: exercise.name,
      muscle_group: exercise.muscle_group,
      sets: p.sets,
      reps: p.reps,
      weight,
      weight_display: display,
      rest_seconds: p.restSec,
    };
  });
}
