ALTER TABLE ingredients ADD COLUMN is_bistro INTEGER NOT NULL DEFAULT 0;
UPDATE ingredients
   SET is_bistro = 1
 WHERE is_produced = 1
   AND name LIKE '%wheat bread%';
