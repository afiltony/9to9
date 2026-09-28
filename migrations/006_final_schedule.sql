-- Brings an existing event in line with the final schedule (Schedule fnl.docx).
-- On a fresh database there are no activities yet and every statement matches nothing;
-- the seed then creates the final schedule directly.
-- Bookings on slots that leave the schedule are cancelled (never deleted), with an audit entry.

SET @event := (SELECT event_id FROM activities WHERE name = 'Registration' ORDER BY created_at LIMIT 1);
SET @day1 := (SELECT DATE(start_at) FROM events WHERE id = @event);

-- 1. Registration
UPDATE activities SET venue = 'Reception Area' WHERE event_id = @event AND name = 'Registration';

-- 2. Installation of the relic becomes its own open-to-all item (it was Music Ministry's 09:30 slot)
INSERT INTO activities (id, event_id, name, venue, capacity, requires_slot, multi_slot, sort_order, active)
SELECT UUID(), @event, 'Installation of Relic & Statue of St. Carlo', 'Central Stage', NULL, 0, 0, 15, 1 FROM DUAL
 WHERE @event IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM activities WHERE event_id = @event AND name = 'Installation of Relic & Statue of St. Carlo');
SET @install := (SELECT id FROM activities WHERE event_id = @event AND name = 'Installation of Relic & Statue of St. Carlo' LIMIT 1);
SET @music := (SELECT id FROM activities WHERE event_id = @event AND name IN ('Music Ministry', 'Music Ministry & Talk') LIMIT 1);

INSERT INTO audit_logs (id, participant_id, action, old_value, new_value)
SELECT UUID(), ps.participant_id, 'BOOKING_CANCELLED',
       JSON_OBJECT('slot', CONCAT('Music Ministry ', s.start_at)),
       JSON_OBJECT('reason', 'Final schedule: the installation of the relic is open to all, no booking needed')
  FROM participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id
 WHERE s.activity_id = @music AND TIME(s.start_at) = '09:30:00' AND ps.status = 'confirmed';
UPDATE participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id
   SET ps.status = 'cancelled'
 WHERE s.activity_id = @music AND TIME(s.start_at) = '09:30:00' AND ps.status = 'confirmed';
UPDATE activity_slots SET activity_id = @install, label = NULL, capacity = NULL, registration_count = 0
 WHERE activity_id = @music AND @install IS NOT NULL AND TIME(start_at) = '09:30:00';

-- 3. Music Ministry & Talk
UPDATE activities SET name = 'Music Ministry & Talk', venue = 'Central Stage' WHERE id = @music;

-- 4. Adoration
UPDATE activities SET venue = 'Green Matte Studio' WHERE event_id = @event AND name = 'Adoration';

-- 6. Rosary Making Workshop: no 1-2 PM slot; add 6-7 PM
SET @rosary := (SELECT id FROM activities WHERE event_id = @event AND name = 'Rosary Making Workshop' LIMIT 1);
UPDATE activities SET venue = 'Front Garden' WHERE id = @rosary;
DELETE FROM activity_slots
 WHERE activity_id = @rosary AND TIME(start_at) = '13:00:00'
   AND NOT EXISTS (SELECT 1 FROM participant_slots ps WHERE ps.slot_id = activity_slots.id);
UPDATE activity_slots SET status = 'closed' WHERE activity_id = @rosary AND TIME(start_at) = '13:00:00';
INSERT INTO activity_slots (id, activity_id, start_at, end_at, capacity)
SELECT UUID(), a.id, TIMESTAMP(@day1, '18:00:00'), TIMESTAMP(@day1, '19:00:00'), a.capacity FROM activities a
 WHERE a.id = @rosary
   AND NOT EXISTS (SELECT 1 FROM activity_slots s WHERE s.activity_id = a.id AND s.start_at = TIMESTAMP(@day1, '18:00:00'));

-- 7. Selfie Point
UPDATE activities SET name = 'Selfie Point', venue = 'Front Garden' WHERE event_id = @event AND name IN ('Selfie Point Zone', 'Selfie Point');

-- 8. Blood Donation (new): Incubation Centre, 5 per slot
INSERT INTO activities (id, event_id, name, venue, capacity, requires_slot, multi_slot, sort_order, active)
SELECT UUID(), @event, 'Blood Donation', 'Incubation Centre', 5, 1, 0, 65, 1 FROM DUAL
 WHERE @event IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM activities WHERE event_id = @event AND name = 'Blood Donation');
SET @blood := (SELECT id FROM activities WHERE event_id = @event AND name = 'Blood Donation' LIMIT 1);
INSERT INTO activity_slots (id, activity_id, start_at, end_at, capacity)
SELECT UUID(), @blood, TIMESTAMP(@day1, MAKETIME(h.h, 0, 0)), TIMESTAMP(@day1, MAKETIME(h.h + 1, 0, 0)), 5
  FROM (SELECT 10 AS h UNION ALL SELECT 11 UNION ALL SELECT 12 UNION ALL SELECT 14 UNION ALL SELECT 15
        UNION ALL SELECT 16 UNION ALL SELECT 17 UNION ALL SELECT 18) h
 WHERE @blood IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM activity_slots s WHERE s.activity_id = @blood);

-- 9. Garden of Joy / Confession: add 5-6 PM and 6-7 PM
SET @garden := (SELECT id FROM activities WHERE event_id = @event AND name = 'Garden of Joy / Confession' LIMIT 1);
UPDATE activities SET venue = 'Theatre Block' WHERE id = @garden;
INSERT INTO activity_slots (id, activity_id, start_at, end_at, capacity)
SELECT UUID(), a.id, TIMESTAMP(@day1, MAKETIME(h.h, 0, 0)), TIMESTAMP(@day1, MAKETIME(h.h + 1, 0, 0)), a.capacity
  FROM activities a JOIN (SELECT 17 AS h UNION ALL SELECT 18) h
 WHERE a.id = @garden
   AND NOT EXISTS (SELECT 1 FROM activity_slots s WHERE s.activity_id = a.id AND s.start_at = TIMESTAMP(@day1, MAKETIME(h.h, 0, 0)));

-- 10. Theatre becomes "Life of St. Carlo & Eucharistic Miracles", in the Theatre
UPDATE activities SET name = 'Life of St. Carlo & Eucharistic Miracles', venue = 'Theatre'
 WHERE event_id = @event AND name = 'Theatre';

-- 11. VR Experience Show: add 6-7 PM
SET @vr := (SELECT id FROM activities WHERE event_id = @event AND name = 'VR Experience Show' LIMIT 1);
UPDATE activities SET venue = 'Media Department Side' WHERE id = @vr;
INSERT INTO activity_slots (id, activity_id, start_at, end_at, capacity)
SELECT UUID(), a.id, TIMESTAMP(@day1, '18:00:00'), TIMESTAMP(@day1, '19:00:00'), a.capacity FROM activities a
 WHERE a.id = @vr
   AND NOT EXISTS (SELECT 1 FROM activity_slots s WHERE s.activity_id = a.id AND s.start_at = TIMESTAMP(@day1, '18:00:00'));

-- Meet with Bishop is not in the final schedule: bookings cancelled, activity switched off
-- (it can be switched back on in Admin > Activities)
INSERT INTO audit_logs (id, participant_id, action, old_value, new_value)
SELECT UUID(), ps.participant_id, 'BOOKING_CANCELLED',
       JSON_OBJECT('slot', CONCAT(a.name, ' ', s.start_at)),
       JSON_OBJECT('reason', 'Final schedule: Meet with Bishop removed')
  FROM participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id JOIN activities a ON a.id = s.activity_id
 WHERE a.event_id = @event AND a.name = 'Meet with Bishop' AND ps.status = 'confirmed';
UPDATE participant_slots ps JOIN activity_slots s ON s.id = ps.slot_id JOIN activities a ON a.id = s.activity_id
   SET ps.status = 'cancelled'
 WHERE a.event_id = @event AND a.name = 'Meet with Bishop' AND ps.status = 'confirmed';
UPDATE activity_slots s JOIN activities a ON a.id = s.activity_id
   SET s.registration_count = 0
 WHERE a.event_id = @event AND a.name = 'Meet with Bishop';
UPDATE activities SET active = 0 WHERE event_id = @event AND name = 'Meet with Bishop';

-- Home page feature text, where it is still the original wording
UPDATE events
   SET content = JSON_SET(content, '$.features', JSON_ARRAY(
     JSON_OBJECT('title', 'Faith', 'text', 'Adoration, Garden of Joy (Confession), the Night Vigil and Holy Qurbana.'),
     JSON_OBJECT('title', 'Music', 'text', 'Music Ministry & Talk at the Central Stage, Ruha Band and the cultural programme.'),
     JSON_OBJECT('title', 'Community', 'text', 'Life of St. Carlo & Eucharistic Miracles, Blood Donation, and a day and night together with young people.'),
     JSON_OBJECT('title', 'Experience', 'text', 'VR Experience Show, Rosary Making Workshop and the Selfie Point.')))
 WHERE content IS NOT NULL AND JSON_VALID(content) AND content LIKE '%Meet with Bishop, theatre%';
