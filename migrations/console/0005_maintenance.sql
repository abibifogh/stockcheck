CREATE TABLE IF NOT EXISTS mx_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS mx_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id       INTEGER REFERENCES mx_categories (id),
  name              TEXT NOT NULL UNIQUE,
  unit              TEXT NOT NULL DEFAULT 'pcs',
    par_level         REAL NOT NULL DEFAULT 0,
  opening_stock     REAL NOT NULL DEFAULT 0,
  default_unit_cost REAL NOT NULL DEFAULT 0,
      is_common         INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  note              TEXT
);
CREATE INDEX IF NOT EXISTS idx_mx_items_category ON mx_items (category_id);
CREATE TABLE IF NOT EXISTS mx_areas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'room',     block      TEXT,                              sort_order INTEGER NOT NULL DEFAULT 100,
  active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_mx_areas_kind ON mx_areas (kind, sort_order);
CREATE TABLE IF NOT EXISTS mx_issues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  day       TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  item_id   INTEGER NOT NULL REFERENCES mx_items (id),
  area_id   INTEGER REFERENCES mx_areas (id),
  qty       REAL NOT NULL,
  job_ref   TEXT,
  note      TEXT,
  issued_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mx_issues_day ON mx_issues (day);
CREATE INDEX IF NOT EXISTS idx_mx_issues_item ON mx_issues (item_id, day);
CREATE INDEX IF NOT EXISTS idx_mx_issues_area ON mx_issues (area_id, day);
CREATE TABLE IF NOT EXISTS mx_purchases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,
  item_id    INTEGER NOT NULL REFERENCES mx_items (id),
  qty        REAL NOT NULL,
  unit_cost  REAL NOT NULL,
  supplier   TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mx_purchases_day ON mx_purchases (day);
CREATE INDEX IF NOT EXISTS idx_mx_purchases_item ON mx_purchases (item_id, day);
CREATE TABLE IF NOT EXISTS mx_counts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  item_id     INTEGER NOT NULL REFERENCES mx_items (id),
  counted_qty REAL NOT NULL,
  note        TEXT,
  UNIQUE (day, item_id)
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('mx_enabled', '1'),
    ('mx_low_cover_days', '7');
INSERT OR IGNORE INTO mx_categories (name, sort_order) VALUES
  ('Electrical', 10),
  ('Plumbing', 20),
  ('Hardware & Fittings', 30),
  ('Paint & Finishing', 40),
  ('Air Conditioning', 50),
  ('Tools & Consumables', 60);
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'LED Bulb 9W', 'pcs', 40, 1, 25 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'LED Bulb 9W');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'LED Bulb 12W', 'pcs', 25, 1, 32 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'LED Bulb 12W');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Fluorescent Tube 4ft', 'pcs', 15, 0, 45 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Fluorescent Tube 4ft');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Light Switch 1-Gang', 'pcs', 15, 1, 18 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Light Switch 1-Gang');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Wall Socket 13A', 'pcs', 15, 1, 28 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Wall Socket 13A');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Circuit Breaker 16A', 'pcs', 8, 0, 65 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Circuit Breaker 16A');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Cable 2.5mm', 'm', 100, 0, 12 FROM mx_categories WHERE name = 'Electrical'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Cable 2.5mm');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Tap Washer Set', 'set', 30, 1, 8 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Tap Washer Set');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'PTFE Thread Tape', 'roll', 25, 1, 6 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'PTFE Thread Tape');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Basin Tap', 'pcs', 8, 0, 180 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Basin Tap');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Shower Head', 'pcs', 10, 1, 120 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Shower Head');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Flexible Hose 40cm', 'pcs', 12, 1, 35 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Flexible Hose 40cm');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Toilet Seat', 'pcs', 6, 0, 150 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Toilet Seat');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Cistern Ball Valve', 'pcs', 8, 0, 75 FROM mx_categories WHERE name = 'Plumbing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Cistern Ball Valve');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Door Handle Set', 'set', 10, 1, 140 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Door Handle Set');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Door Lock Cylinder', 'pcs', 10, 1, 95 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Door Lock Cylinder');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Door Hinge', 'pcs', 24, 0, 22 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Door Hinge');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Wall Plugs & Screws', 'set', 40, 1, 5 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Wall Plugs & Screws');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Silicone Sealant', 'tube', 20, 1, 42 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Silicone Sealant');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Curtain Hook', 'pcs', 100, 0, 2 FROM mx_categories WHERE name = 'Hardware & Fittings'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Curtain Hook');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Emulsion Paint White', 'L', 40, 1, 55 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Emulsion Paint White');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Gloss Paint', 'L', 15, 0, 78 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Gloss Paint');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Paint Brush 3in', 'pcs', 15, 0, 18 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Paint Brush 3in');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Paint Roller', 'pcs', 12, 0, 25 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Paint Roller');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Wall Filler', 'kg', 20, 0, 30 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Wall Filler');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Sandpaper Sheet', 'pcs', 50, 0, 4 FROM mx_categories WHERE name = 'Paint & Finishing'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Sandpaper Sheet');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'AC Filter', 'pcs', 20, 1, 60 FROM mx_categories WHERE name = 'Air Conditioning'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'AC Filter');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Refrigerant R410A', 'kg', 10, 0, 320 FROM mx_categories WHERE name = 'Air Conditioning'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Refrigerant R410A');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'AC Capacitor', 'pcs', 8, 0, 110 FROM mx_categories WHERE name = 'Air Conditioning'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'AC Capacitor');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'AC Remote Control', 'pcs', 6, 0, 85 FROM mx_categories WHERE name = 'Air Conditioning'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'AC Remote Control');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Insulation Tape', 'roll', 30, 1, 7 FROM mx_categories WHERE name = 'Tools & Consumables'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Insulation Tape');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Cutting Disc 4in', 'pcs', 20, 0, 15 FROM mx_categories WHERE name = 'Tools & Consumables'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Cutting Disc 4in');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Drill Bit Set', 'set', 5, 0, 90 FROM mx_categories WHERE name = 'Tools & Consumables'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Drill Bit Set');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'Cable Ties', 'pcs', 200, 0, 1 FROM mx_categories WHERE name = 'Tools & Consumables'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'Cable Ties');
INSERT INTO mx_items (category_id, name, unit, par_level, is_common, default_unit_cost)
  SELECT id, 'AA Batteries', 'pcs', 60, 1, 6 FROM mx_categories WHERE name = 'Tools & Consumables'
  AND NOT EXISTS (SELECT 1 FROM mx_items WHERE name = 'AA Batteries');
INSERT OR IGNORE INTO mx_areas (name, kind, block, sort_order) VALUES
  ('Reception',        'area', 'Public',   10),
  ('Lobby',            'area', 'Public',   20),
  ('Restaurant',       'area', 'Public',   30),
  ('Breakfast Kitchen','area', 'Back',     40),
  ('Corridors',        'area', 'Public',   50),
  ('Laundry',          'area', 'Back',     60),
  ('Staff Quarters',   'area', 'Back',     70),
  ('Generator Room',   'area', 'Plant',    80),
  ('Water Plant',      'area', 'Plant',    90),
  ('Grounds & Car Park','area','Outside', 100);
