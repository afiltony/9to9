-- Blood Donation takes 8 people per slot (was 5).
UPDATE activities SET capacity = 8 WHERE name = 'Blood Donation';
UPDATE activity_slots s JOIN activities a ON a.id = s.activity_id
   SET s.capacity = 8
 WHERE a.name = 'Blood Donation';
