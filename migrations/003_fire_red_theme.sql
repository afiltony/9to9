-- Brand colours move from slate grey to fire red. Only events still on the old
-- grey defaults are changed; a colour an admin picked in Settings is kept.
UPDATE events
   SET content = JSON_SET(content, '$.theme.primary', '#ce2029')
 WHERE content IS NOT NULL AND JSON_VALID(content)
   AND LOWER(JSON_VALUE(content, '$.theme.primary')) = '#525f6d';

UPDATE events
   SET content = JSON_SET(content, '$.theme.secondary', '#ffb627')
 WHERE content IS NOT NULL AND JSON_VALID(content)
   AND LOWER(JSON_VALUE(content, '$.theme.secondary')) = '#c9ced6';
