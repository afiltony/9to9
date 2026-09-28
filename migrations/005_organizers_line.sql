-- New organizers line; also replaces a copy saved from Settings.
UPDATE events
   SET content = JSON_SET(content, '$.organizers', 'Organized by: MAAC | Yuvadeepti SMYM | CSM | Jesus Youth')
 WHERE content IS NOT NULL AND JSON_VALID(content);
