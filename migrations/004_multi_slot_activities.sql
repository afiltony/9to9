-- An activity can let a participant book more than one of its time slots (e.g. the Night
-- Vigil, which runs all night in several slots with nothing else at the same time).
ALTER TABLE activities ADD COLUMN multi_slot TINYINT(1) NOT NULL DEFAULT 0 AFTER requires_slot;

UPDATE activities SET multi_slot = 1 WHERE name = 'Night Vigil';

-- Holy Qurbana becomes bookable, with no limit on places
UPDATE activities SET requires_slot = 1 WHERE name = 'Holy Qurbana';
