-- Organizers line to match the organizers' logo strip; also replaces a copy saved from Settings.
UPDATE events
   SET content = JSON_SET(content, '$.organizers', 'Organized by Media Village, Media Apostolate, Archeparchy of Changanassery | In association with Yuvadeepti SMYM, Jesus Youth and CSM (Catholic Students Movement)')
 WHERE content IS NOT NULL AND JSON_VALID(content);
