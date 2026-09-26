-- Card printing workflow, branding and editable site content.

-- cards are printed by the organizers and handed over at reception
ALTER TABLE participants
  ADD COLUMN card_printed_at DATETIME NULL AFTER status,
  ADD COLUMN card_print_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER card_printed_at,
  ADD INDEX idx_participants_card_printed (event_id, card_printed_at);

ALTER TABLE events
  ADD COLUMN contact_phone VARCHAR(50) NULL AFTER help_desk_text,
  ADD COLUMN contact_email VARCHAR(255) NULL AFTER contact_phone,
  ADD COLUMN hero_image_path VARCHAR(255) NULL AFTER contact_email,
  ADD COLUMN logo_path VARCHAR(255) NULL AFTER hero_image_path,
  -- free-form editable content: intro text, feature cards, organizers, privacy/terms text
  ADD COLUMN content JSON NULL AFTER logo_path;

ALTER TABLE activities
  ADD COLUMN image_path VARCHAR(255) NULL AFTER venue;

ALTER TABLE checkins
  ADD INDEX idx_checkins_time (checked_in_at);
