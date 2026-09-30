-- Organizers line to match the new logo strip (all four organize, with the feast sponsors);
-- also replaces a copy saved from Settings.
UPDATE events
   SET content = JSON_SET(content, '$.organizers', 'Organized by Media Village (Media Apostolate, Archeparchy of Changanassery), Yuvadeepti SMYM, Jesus Youth and CSM (Catholic Students Movement) | തിരുനാൾ പ്രസുദേന്തി: ജിമ്മി പടനിലം, ഡോ. ജോർജ് & മറിയം പടനിലം ചാരിറ്റബിൾ ഫൗണ്ടേഷൻ')
 WHERE content IS NOT NULL AND JSON_VALID(content);
