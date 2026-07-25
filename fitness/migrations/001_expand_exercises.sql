-- Rust Fitness App: Expanded Exercise Database
-- Run in Supabase SQL Editor against the fitness project (aflqnvlhpkbokfneyhqh)
-- Adds is_compound column and expands from 25 to 100+ exercises

-- Step 1: Add is_compound column if it doesn't exist
ALTER TABLE exercises ADD COLUMN IF NOT EXISTS is_compound boolean DEFAULT false;

-- Step 2: Mark existing exercises as compound or isolation
UPDATE exercises SET is_compound = true WHERE name IN (
  'Barbell Bench Press', 'Barbell Squat', 'Barbell Deadlift',
  'Barbell Overhead Press', 'Barbell Row', 'Pull-ups',
  'Dumbbell Bench Press', 'Dumbbell Shoulder Press',
  'Leg Press', 'Lat Pulldown'
);

-- Step 3: Insert new exercises (ON CONFLICT skip duplicates)
-- Assumes exercises table has: id (uuid default), name (unique), muscle_group, equipment_needed (text[]), is_compound

INSERT INTO exercises (name, muscle_group, equipment_needed, is_compound) VALUES
-- CHEST (compounds)
('Incline Barbell Bench Press', 'chest', ARRAY['Barbell', 'Adjustable Bench'], true),
('Decline Barbell Bench Press', 'chest', ARRAY['Barbell', 'Decline Bench'], true),
('Incline Dumbbell Bench Press', 'chest', ARRAY['Dumbbells', 'Adjustable Bench'], true),
('Decline Dumbbell Bench Press', 'chest', ARRAY['Dumbbells', 'Decline Bench'], true),
('Push-ups', 'chest', ARRAY[]::text[], true),
('Dip (Chest)', 'chest', ARRAY['Dip Station'], true),
('Smith Machine Bench Press', 'chest', ARRAY['Smith Machine'], true),
('Chest Press Machine', 'chest', ARRAY['Chest Press Machine'], true),
('Landmine Press', 'chest', ARRAY['Barbell', 'Landmine Attachment'], true),
-- CHEST (isolations)
('Dumbbell Fly', 'chest', ARRAY['Dumbbells', 'Flat Bench'], false),
('Incline Dumbbell Fly', 'chest', ARRAY['Dumbbells', 'Adjustable Bench'], false),
('Cable Fly', 'chest', ARRAY['Cable Machine'], false),
('Pec Deck Fly', 'chest', ARRAY['Pec Deck / Fly Machine'], false),
('Cable Crossover', 'chest', ARRAY['Cable Machine'], false),
('Bodyweight Chest Fly (Floor)', 'chest', ARRAY[]::text[], false),

-- SHOULDERS (compounds)
('Seated Dumbbell Shoulder Press', 'shoulders', ARRAY['Dumbbells', 'Adjustable Bench'], true),
('Arnold Press', 'shoulders', ARRAY['Dumbbells'], true),
('Smith Machine Overhead Press', 'shoulders', ARRAY['Smith Machine'], true),
('Shoulder Press Machine', 'shoulders', ARRAY['Shoulder Press Machine'], true),
('Push Press', 'shoulders', ARRAY['Barbell'], true),
('Landmine Shoulder Press', 'shoulders', ARRAY['Barbell', 'Landmine Attachment'], true),
('Pike Push-ups', 'shoulders', ARRAY[]::text[], true),
-- SHOULDERS (isolations)
('Dumbbell Lateral Raise', 'shoulders', ARRAY['Dumbbells'], false),
('Cable Lateral Raise', 'shoulders', ARRAY['Cable Machine'], false),
('Dumbbell Front Raise', 'shoulders', ARRAY['Dumbbells'], false),
('Dumbbell Rear Delt Fly', 'shoulders', ARRAY['Dumbbells'], false),
('Cable Face Pull', 'shoulders', ARRAY['Cable Machine'], false),
('Reverse Pec Deck', 'shoulders', ARRAY['Pec Deck / Fly Machine'], false),
('Resistance Band Pull-apart', 'shoulders', ARRAY['Resistance Bands'], false),
('Plate Front Raise', 'shoulders', ARRAY['Weight Plates (standalone)'], false),
('Upright Row', 'shoulders', ARRAY['Barbell'], false),

-- TRICEPS (isolations — most triceps-only exercises are isolations)
('Tricep Pushdown (Cable)', 'triceps', ARRAY['Cable Machine'], false),
('Overhead Tricep Extension (Cable)', 'triceps', ARRAY['Cable Machine'], false),
('Skull Crushers', 'triceps', ARRAY['EZ Curl Bar', 'Flat Bench'], false),
('Dumbbell Kickback', 'triceps', ARRAY['Dumbbells'], false),
('Overhead Dumbbell Extension', 'triceps', ARRAY['Dumbbells'], false),
('Bodyweight Tricep Dip', 'triceps', ARRAY[]::text[], false),
('Close-Grip Bench Press', 'triceps', ARRAY['Barbell', 'Flat Bench'], true),
('Diamond Push-ups', 'triceps', ARRAY[]::text[], false),
('Resistance Band Pushdown', 'triceps', ARRAY['Resistance Bands'], false),

-- BACK (compounds)
('Barbell Bent-Over Row', 'back', ARRAY['Barbell'], true),
('Dumbbell Row', 'back', ARRAY['Dumbbells', 'Flat Bench'], true),
('T-Bar Row', 'back', ARRAY['Barbell', 'T-Bar Row Platform'], true),
('Seated Cable Row', 'back', ARRAY['Cable Machine'], true),
('Seated Row Machine', 'back', ARRAY['Seated Row Machine'], true),
('Chin-ups', 'back', ARRAY['Pull-up Bar'], true),
('Inverted Row', 'back', ARRAY['Smith Machine'], true),
('Bodyweight Row (Table/Bar)', 'back', ARRAY[]::text[], true),
('Landmine Row', 'back', ARRAY['Barbell', 'Landmine Attachment'], true),
('Renegade Row', 'back', ARRAY['Dumbbells'], true),
('Kettlebell Row', 'back', ARRAY['Kettlebells'], true),
-- BACK (isolations)
('Straight-Arm Pulldown', 'back', ARRAY['Cable Machine'], false),
('Cable Pullover', 'back', ARRAY['Cable Machine'], false),
('Dumbbell Pullover', 'back', ARRAY['Dumbbells', 'Flat Bench'], false),
('Resistance Band Row', 'back', ARRAY['Resistance Bands'], false),
('Superman Hold', 'back', ARRAY[]::text[], false),

-- BICEPS (isolations — almost all bicep exercises are isolations)
('Barbell Curl', 'biceps', ARRAY['Barbell'], false),
('EZ Bar Curl', 'biceps', ARRAY['EZ Curl Bar'], false),
('Dumbbell Curl', 'biceps', ARRAY['Dumbbells'], false),
('Hammer Curl', 'biceps', ARRAY['Dumbbells'], false),
('Concentration Curl', 'biceps', ARRAY['Dumbbells'], false),
('Incline Dumbbell Curl', 'biceps', ARRAY['Dumbbells', 'Adjustable Bench'], false),
('Preacher Curl (EZ Bar)', 'biceps', ARRAY['EZ Curl Bar', 'Preacher Curl Bench'], false),
('Cable Curl', 'biceps', ARRAY['Cable Machine'], false),
('Preacher Curl Machine', 'biceps', ARRAY['Preacher Curl Machine'], false),
('Kettlebell Curl', 'biceps', ARRAY['Kettlebells'], false),
('Resistance Band Curl', 'biceps', ARRAY['Resistance Bands'], false),

-- LEGS (compounds)
('Back Squat', 'legs', ARRAY['Barbell', 'Squat Rack'], true),
('Front Squat', 'legs', ARRAY['Barbell', 'Squat Rack'], true),
('Goblet Squat', 'legs', ARRAY['Dumbbells'], true),
('Bulgarian Split Squat', 'legs', ARRAY['Dumbbells'], true),
('Romanian Deadlift', 'legs', ARRAY['Barbell'], true),
('Dumbbell Romanian Deadlift', 'legs', ARRAY['Dumbbells'], true),
('Trap Bar Deadlift', 'legs', ARRAY['Trap Bar'], true),
('Hack Squat', 'legs', ARRAY['Hack Squat Machine'], true),
('Walking Lunge', 'legs', ARRAY['Dumbbells'], true),
('Smith Machine Squat', 'legs', ARRAY['Smith Machine'], true),
('Kettlebell Swing', 'legs', ARRAY['Kettlebells'], true),
('Bodyweight Squat', 'legs', ARRAY[]::text[], true),
('Bodyweight Lunge', 'legs', ARRAY[]::text[], true),
('Step-ups', 'legs', ARRAY['Plyo Box'], true),
('Hip Thrust (Barbell)', 'legs', ARRAY['Barbell', 'Flat Bench'], true),
('Dumbbell Hip Thrust', 'legs', ARRAY['Dumbbells', 'Flat Bench'], true),
-- LEGS (isolations)
('Leg Extension', 'legs', ARRAY['Leg Extension Machine'], false),
('Leg Curl', 'legs', ARRAY['Leg Curl Machine'], false),
('Calf Raise (Machine)', 'legs', ARRAY['Calf Raise Machine'], false),
('Bodyweight Calf Raise', 'legs', ARRAY[]::text[], false),
('Hip Abduction', 'legs', ARRAY['Hip Abductor/Adductor'], false),
('Hip Adduction', 'legs', ARRAY['Hip Abductor/Adductor'], false),
('Glute Ham Raise', 'legs', ARRAY['Roman Chair / GHD'], false),
('Cable Pull-through', 'legs', ARRAY['Cable Machine'], false),

-- ABS (mostly isolations)
('Hanging Leg Raise', 'abs', ARRAY['Pull-up Bar'], false),
('Cable Crunch', 'abs', ARRAY['Cable Machine'], false),
('Ab Wheel Rollout', 'abs', ARRAY['Ab Wheel'], false),
('Plank', 'abs', ARRAY[]::text[], false),
('Side Plank', 'abs', ARRAY[]::text[], false),
('Dead Bug', 'abs', ARRAY[]::text[], false),
('Mountain Climbers', 'abs', ARRAY[]::text[], false),
('Bicycle Crunch', 'abs', ARRAY[]::text[], false),
('Russian Twist', 'abs', ARRAY['Dumbbells'], false),
('Ab Crunch Machine', 'abs', ARRAY['Ab Crunch Machine'], false),
('Bodyweight Crunch', 'abs', ARRAY[]::text[], false),
('Pallof Press', 'abs', ARRAY['Cable Machine'], false),
('GHD Sit-up', 'abs', ARRAY['Roman Chair / GHD'], false),
('Decline Sit-up', 'abs', ARRAY['Decline Bench'], false)

ON CONFLICT (name) DO UPDATE SET
  muscle_group = EXCLUDED.muscle_group,
  equipment_needed = EXCLUDED.equipment_needed,
  is_compound = EXCLUDED.is_compound;
