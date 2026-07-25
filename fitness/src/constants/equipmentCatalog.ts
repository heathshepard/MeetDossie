export type EquipmentConfigType = 'none' | 'weight_range' | 'barbell_plates' | 'machine_load';

export type CatalogItem = {
  name: string;
  type: EquipmentConfigType;
};

export type CatalogCategory = {
  key: 'free_weights' | 'machines' | 'benches_racks' | 'bodyweight';
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
    ],
  },
  {
    key: 'machines',
    label: 'Machines',
    items: [
      { name: 'Cable Machine', type: 'machine_load' },
      { name: 'Leg Press', type: 'machine_load' },
      { name: 'Lat Pulldown', type: 'machine_load' },
      { name: 'Smith Machine', type: 'machine_load' },
    ],
  },
  {
    key: 'benches_racks',
    label: 'Benches & Racks',
    items: [
      { name: 'Squat Rack', type: 'none' },
      { name: 'Flat Bench', type: 'none' },
      { name: 'Adjustable Bench', type: 'none' },
    ],
  },
  {
    key: 'bodyweight',
    label: 'Bodyweight & Accessories',
    items: [
      { name: 'Pull-up Bar', type: 'none' },
      { name: 'Resistance Bands', type: 'none' },
      { name: 'Dip Station', type: 'none' },
    ],
  },
];

export const BARBELL_PLATE_SIZES = [45, 35, 25, 10, 5, 2.5, 1.25];
export const BAR_WEIGHTS = [45, 35, 15];
export const MACHINE_ADDON_SIZES = [1.25, 2.5, 5];
