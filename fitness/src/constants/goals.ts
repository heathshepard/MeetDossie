export const GOALS = [
  { key: 'slim_down', title: 'Slim Down', description: 'Higher volume, shorter rest, calorie-forward programming' },
  { key: 'tone_up', title: 'Tone Up', description: 'Moderate volume, focused on definition and consistency' },
  { key: 'bulk_up', title: 'Bulk Up', description: 'Higher volume, progressive overload, surplus-focused' },
  { key: 'strength_training', title: 'Strength Training', description: 'Lower reps, heavier loads, longer rest between sets' },
] as const;

export type GoalKey = typeof GOALS[number]['key'];
