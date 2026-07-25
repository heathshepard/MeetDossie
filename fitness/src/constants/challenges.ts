export const CHALLENGE_TYPES = [
  {
    key: 'total_volume',
    title: 'Volume King',
    description: 'Highest total volume (weight x reps) this week',
    unit: 'lb',
    icon: '🏋️',
  },
  {
    key: 'most_workouts',
    title: 'Iron Streak',
    description: 'Most workouts completed this week',
    unit: 'workouts',
    icon: '🔥',
  },
  {
    key: 'most_sets',
    title: 'Set Machine',
    description: 'Most total sets logged this week',
    unit: 'sets',
    icon: '⚡',
  },
  {
    key: 'most_reps',
    title: 'Rep Counter',
    description: 'Most total reps performed this week',
    unit: 'reps',
    icon: '💪',
  },
  {
    key: 'heaviest_lift',
    title: 'Heavy Hitter',
    description: 'Heaviest single weight lifted this week',
    unit: 'lb',
    icon: '🏆',
  },
  {
    key: 'most_exercises',
    title: 'Variety Pack',
    description: 'Most unique exercises performed this week',
    unit: 'exercises',
    icon: '🎯',
  },
  {
    key: 'push_volume',
    title: 'Push Power',
    description: 'Highest volume on push day exercises',
    unit: 'lb',
    icon: '👊',
  },
  {
    key: 'pull_volume',
    title: 'Pull Force',
    description: 'Highest volume on pull day exercises',
    unit: 'lb',
    icon: '🧲',
  },
  {
    key: 'leg_volume',
    title: 'Leg Day Legend',
    description: 'Highest volume on leg day exercises',
    unit: 'lb',
    icon: '🦵',
  },
  {
    key: 'consistency',
    title: 'No Days Off',
    description: 'Most days with at least one logged set',
    unit: 'days',
    icon: '📅',
  },
] as const;

export type ChallengeTypeKey = typeof CHALLENGE_TYPES[number]['key'];
