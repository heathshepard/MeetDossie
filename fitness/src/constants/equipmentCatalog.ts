export type EquipmentConfigType = 'none' | 'weight_range' | 'barbell_plates' | 'machine_load';

export type CatalogItem = {
  name: string;
  type: EquipmentConfigType;
};

export type CatalogCategory = {
  key: 'free_weights' | 'machines' | 'cardio' | 'benches_racks' | 'bodyweight';
  label: string;
  items: CatalogItem[];
};

export const EQUIPMENT_CATALOG: CatalogCategory[] = [
  {
    key: 'free_weights',
    label: 'Free Weights',
    items: [
      { name: 'Barbell', type: 'barbell_plates' },
      { name: 'Dumbbells', type: 'weight_range' },
      { name: 'Kettlebells', type: 'weight_range' },
      { name: 'EZ Curl Bar', type: 'none' },
      { name: 'Trap Bar', type: 'barbell_plates' },
      { name: 'Medicine Ball', type: 'weight_range' },
      { name: 'Weight Plates (standalone)', type: 'none' },
    ],
  },
  {
    key: 'machines',
    label: 'Machines',
    items: [
      { name: 'Cable Machine', type: 'machine_load' },
      { name: 'Lat Pulldown', type: 'machine_load' },
      { name: 'Leg Press', type: 'machine_load' },
      { name: 'Smith Machine', type: 'machine_load' },
      { name: 'Leg Curl Machine', type: 'machine_load' },
      { name: 'Leg Extension Machine', type: 'machine_load' },
      { name: 'Chest Press Machine', type: 'machine_load' },
      { name: 'Shoulder Press Machine', type: 'machine_load' },
      { name: 'Pec Deck / Fly Machine', type: 'machine_load' },
      { name: 'Seated Row Machine', type: 'machine_load' },
      { name: 'Hack Squat Machine', type: 'machine_load' },
      { name: 'Calf Raise Machine', type: 'machine_load' },
      { name: 'Hip Abductor/Adductor', type: 'machine_load' },
      { name: 'Assisted Dip/Pull-up Machine', type: 'machine_load' },
      { name: 'Preacher Curl Machine', type: 'machine_load' },
      { name: 'Ab Crunch Machine', type: 'machine_load' },
    ],
  },
  {
    key: 'cardio',
    label: 'Cardio Equipment',
    items: [
      { name: 'Treadmill', type: 'none' },
      { name: 'Stationary Bike', type: 'none' },
      { name: 'Rowing Machine', type: 'none' },
      { name: 'Stairmaster', type: 'none' },
      { name: 'Elliptical', type: 'none' },
      { name: 'Assault/Air Bike', type: 'none' },
    ],
  },
  {
    key: 'benches_racks',
    label: 'Benches & Racks',
    items: [
      { name: 'Squat Rack', type: 'none' },
      { name: 'Flat Bench', type: 'none' },
      { name: 'Adjustable Bench', type: 'none' },
      { name: 'Decline Bench', type: 'none' },
      { name: 'Preacher Curl Bench', type: 'none' },
      { name: 'Roman Chair / GHD', type: 'none' },
      { name: 'Landmine Attachment', type: 'none' },
      { name: 'T-Bar Row Platform', type: 'none' },
    ],
  },
  {
    key: 'bodyweight',
    label: 'Bodyweight & Accessories',
    items: [
      { name: 'Pull-up Bar', type: 'none' },
      { name: 'Dip Station', type: 'none' },
      { name: 'Resistance Bands', type: 'none' },
      { name: 'Suspension Trainer (TRX)', type: 'none' },
      { name: 'Ab Wheel', type: 'none' },
      { name: 'Battle Ropes', type: 'none' },
      { name: 'Foam Roller', type: 'none' },
      { name: 'Jump Rope', type: 'none' },
      { name: 'Plyo Box', type: 'none' },
      { name: 'Glute Ham Roller', type: 'none' },
    ],
  },
];

export const BARBELL_PLATE_SIZES = [45, 35, 25, 10, 5, 2.5, 1.25];
export const BAR_WEIGHTS = [45, 35, 15];
export const MACHINE_ADDON_SIZES = [1.25, 2.5, 5];
