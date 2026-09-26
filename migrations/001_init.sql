-- 9 TO 9 MEET – initial schema (MySQL 8 / MariaDB 10.4+, InnoDB, utf8mb4)
-- All DATETIME values are event-local wall-clock time (see TZ_OFFSET in .env).

CREATE TABLE events (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  subtitle VARCHAR(255) NULL,
  tagline VARCHAR(255) NULL,
  description TEXT NULL,
  venue VARCHAR(255) NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  registration_open_at DATETIME NULL,
  registration_close_at DATETIME NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft',
  -- last issued registration sequence; only ever incremented, so numbers are never reused
  registration_seq INT UNSIGNED NOT NULL DEFAULT 0,
  allow_overlapping_bookings TINYINT(1) NOT NULL DEFAULT 0,
  auto_approve TINYINT(1) NOT NULL DEFAULT 1,
  -- 'mobile' | 'email' | 'mobile_name' | 'none'
  duplicate_rule VARCHAR(20) NOT NULL DEFAULT 'mobile_name',
  -- per-field overrides: {"parish": "hidden", "email": "required", ...}
  form_config JSON NULL,
  help_desk_text VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE participants (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  registration_number VARCHAR(50) NOT NULL UNIQUE,

  first_name VARCHAR(100) NOT NULL,
  middle_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  preferred_name VARCHAR(100) NULL,
  date_of_birth DATE NULL,
  gender VARCHAR(30) NULL,

  mobile VARCHAR(30) NOT NULL,
  whatsapp VARCHAR(30) NULL,
  email VARCHAR(255) NULL,
  address TEXT NULL,
  locality VARCHAR(150) NULL,
  district VARCHAR(100) NULL,
  state VARCHAR(100) NULL,
  pin_code VARCHAR(20) NULL,
  country VARCHAR(100) NULL,

  parish VARCHAR(255) NULL,
  diocese VARCHAR(255) NULL,
  organization VARCHAR(255) NULL,
  institution VARCHAR(255) NULL,
  youth_group VARCHAR(255) NULL,
  coordinator_name VARCHAR(200) NULL,
  coordinator_mobile VARCHAR(30) NULL,

  profile_photo_path VARCHAR(255) NULL,

  accommodation_required TINYINT(1) NOT NULL DEFAULT 0,
  arrival_at DATETIME NULL,
  departure_at DATETIME NULL,
  accommodation_notes VARCHAR(500) NULL,
  food_required TINYINT(1) NOT NULL DEFAULT 0,
  food_preference VARCHAR(100) NULL,
  dietary_notes VARCHAR(500) NULL,

  consent_information TINYINT(1) NOT NULL DEFAULT 0,
  consent_rules TINYINT(1) NOT NULL DEFAULT 0,
  consent_media TINYINT(1) NOT NULL DEFAULT 0,

  -- pending | approved | rejected | cancelled
  status VARCHAR(30) NOT NULL DEFAULT 'pending',

  -- scanned by staff at check-in; never grants document access
  qr_token CHAR(43) NOT NULL UNIQUE,
  -- secret link the participant uses to download their cards
  access_token CHAR(43) NOT NULL UNIQUE,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_participants_event FOREIGN KEY (event_id) REFERENCES events(id),
  INDEX idx_participants_event_mobile (event_id, mobile),
  INDEX idx_participants_event_email (event_id, email),
  INDEX idx_participants_event_status (event_id, status),
  INDEX idx_participants_name (first_name, last_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE emergency_contacts (
  id CHAR(36) NOT NULL PRIMARY KEY,
  participant_id CHAR(36) NOT NULL,
  name VARCHAR(200) NOT NULL,
  relationship VARCHAR(100) NULL,
  mobile VARCHAR(30) NOT NULL,
  alternate_mobile VARCHAR(30) NULL,
  email VARCHAR(255) NULL,
  address TEXT NULL,
  CONSTRAINT fk_emergency_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE activities (
  id CHAR(36) NOT NULL PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  venue VARCHAR(255) NULL,
  -- default capacity for new slots; NULL = no limit
  capacity INT UNSIGNED NULL,
  -- FALSE = open programme item shown on the schedule but not booked
  requires_slot TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_activities_event FOREIGN KEY (event_id) REFERENCES events(id),
  INDEX idx_activities_event (event_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE activity_slots (
  id CHAR(36) NOT NULL PRIMARY KEY,
  activity_id CHAR(36) NOT NULL,
  -- e.g. speaker or programme detail for this slot
  label VARCHAR(255) NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  -- NULL = no limit
  capacity INT UNSIGNED NULL,
  -- maintained inside the booking transaction under a row lock
  registration_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- open | closed
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_slots_activity FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE,
  CONSTRAINT chk_slot_times CHECK (end_at > start_at),
  INDEX idx_slots_activity_start (activity_id, start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE participant_slots (
  id CHAR(36) NOT NULL PRIMARY KEY,
  participant_id CHAR(36) NOT NULL,
  slot_id CHAR(36) NOT NULL,
  -- confirmed | cancelled
  status VARCHAR(30) NOT NULL DEFAULT 'confirmed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ps_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_slot FOREIGN KEY (slot_id) REFERENCES activity_slots(id) ON DELETE CASCADE,
  UNIQUE KEY uq_participant_slot (participant_id, slot_id),
  INDEX idx_ps_slot (slot_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  -- SUPER_ADMIN | ADMIN | REGISTRATION_MANAGER | CHECKIN_STAFF | REPORT_MANAGER
  role VARCHAR(50) NOT NULL DEFAULT 'CHECKIN_STAFF',
  active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE checkins (
  id CHAR(36) NOT NULL PRIMARY KEY,
  participant_id CHAR(36) NOT NULL,
  slot_id CHAR(36) NULL,
  -- EVENT_ENTRY | ACTIVITY_ENTRY
  checkin_type VARCHAR(50) NOT NULL,
  -- participant_id + ':' + (slot_id or 'EVENT'); makes duplicate check-ins impossible
  dedupe_key VARCHAR(80) NOT NULL UNIQUE,
  checked_in_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scanned_by CHAR(36) NULL,
  ip_address VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  notes TEXT NULL,
  CONSTRAINT fk_checkins_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  CONSTRAINT fk_checkins_slot FOREIGN KEY (slot_id) REFERENCES activity_slots(id) ON DELETE SET NULL,
  CONSTRAINT fk_checkins_admin FOREIGN KEY (scanned_by) REFERENCES admin_users(id) ON DELETE SET NULL,
  INDEX idx_checkins_slot (slot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE participant_documents (
  id CHAR(36) NOT NULL PRIMARY KEY,
  participant_id CHAR(36) NOT NULL,
  -- ID_CARD | ACTIVITY_CARD
  document_type VARCHAR(50) NOT NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  generated_by CHAR(36) NULL,
  CONSTRAINT fk_docs_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE,
  INDEX idx_docs_participant (participant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id CHAR(36) NOT NULL PRIMARY KEY,
  admin_user_id CHAR(36) NULL,
  participant_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  ip_address VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_admin FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_participant FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE SET NULL,
  INDEX idx_audit_participant (participant_id),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  session_id VARCHAR(128) NOT NULL PRIMARY KEY,
  expires BIGINT UNSIGNED NOT NULL,
  data MEDIUMTEXT NOT NULL,
  INDEX idx_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
