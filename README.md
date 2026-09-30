# 9 TO 9 MEET – Registration & Check-in

Event registration, capacity-safe activity-slot booking, two PDF participant cards (ID card + activity card)
and QR check-in for **9 TO 9 MEET – 24 Hour God Experience** (10 Oct 9:00 AM → 11 Oct 9:00 AM).

Built for **Hostinger Business shared hosting**: one Node.js process, MySQL/MariaDB, and only pure-JavaScript
dependencies (no headless Chrome, no native image libraries).

| | |
|---|---|
| Runtime | Node.js 20+ · Express 5 · EJS server-rendered pages |
| Database | MySQL 8 / MariaDB 10.4+ (XAMPP locally, Hostinger MySQL in production) |
| PDFs | pdfkit (ID card 10 × 12.5 cm, activity card A5) |
| QR | `qrcode` on the server; `html5-qrcode` scanner in the browser |

## The workflow

1. **Participants register online** at `/register`: an 8-step wizard (personal → contact → organization →
   emergency → requirements → activities → consent → confirm). They get a registration number, a QR code and a
   private link to their cards straight away.
2. **Organizers print the cards** at **Admin → Print cards**. Cards are filled in automatically from the registration.
   Print everything not yet printed in batches of 150, either one card per page for a PVC card printer, or 9 per A4
   sheet (double-sided, with crop marks) for card stock. Printed cards are tracked, so each batch picks up where the
   last one stopped.
3. **Reception hands the cards over.** At **Admin → Check-in** (station: Reception), scan the QR or search by number,
   mobile or name. Check the photo, hand over the card, and press **Card handed over · Check in**. If a card was never
   printed, a **Print ID card now** button appears on that screen.
4. **Activity volunteers** pick their slot as the station and scan cards at the door. The screen shows
   BOOKED ✓, NOT BOOKED or ALREADY CHECKED IN.

## Features

- **Public site:** home (hero with the event poster), about, schedule timeline, activities with live capacity bars and
  “Book this slot”, contact, privacy and terms pages. It includes SEO, Open Graph and schema.org Event metadata.
  Pages are mobile-first, with self-hosted Poppins/Inter fonts, keyboard and screen-reader support, and reduced
  motion when the device asks for it.
- **Registration:** drag-and-drop photo upload that is resized in the browser (date of birth is no longer asked;
  it can be switched back on in Settings). Mobile numbers accept a country code. Seat counts refresh live from the server, and time conflicts are
  shown as they happen. There is a review step with Edit links, and a local draft keeps typed data if the page is
  refreshed.
- **Booking safety:** each registration runs in one transaction that locks the event row and the chosen slot rows
  (`SELECT … FOR UPDATE`), so a slot can never be overbooked. A test fires 45 simultaneous registrations at a
  20-place slot to prove it.
- **Cards (PDF):** a 10 × 12.5 cm ID card (front: photo, details and QR code; back: all booked activities) and an A5 activity card. Fonts are embedded and
  QR codes are drawn as vector graphics. The QR holds only `BASE_URL/checkin/<random token>`, never personal data.
- **Admin:**
  - Dashboard with metrics, capacity bars and registrations per day.
  - Participants with search, 10 filters, sorting, photo thumbnails, quick approve and bulk print.
  - Participant detail with tabs (overview, contact, emergency, activities, documents, check-in history, audit
    history), editing, and adding or cancelling bookings.
  - Activities and time slots management (capacity can't be set below the bookings already made).
  - Settings for event dates (moving the dates shifts every slot), the registration window and rules, which form
    fields are required/optional/hidden, food options, hero image, logo, brand colours, website text, contact
    details, and the privacy and terms text.
  - Staff users and roles, and an audit log.
- **Reports** (screen, CSV, Excel, PDF): participants, activities, slot occupancy, per-slot participant list,
  attendance, accommodation, food, organization, parish and district.
- **Roles:** `SUPER_ADMIN`, `ADMIN`, `REGISTRATION_MANAGER`, `CHECKIN_STAFF`, `REPORT_MANAGER`
  (see `PERMISSIONS` in [src/lib/security.js](src/lib/security.js)).

**Not included:** sending email or WhatsApp. Forgotten passwords are reset by an admin in Users & roles.

## Local setup (Windows + XAMPP)

1. Start **MySQL** from the XAMPP control panel.
2. Create the databases:
   ```
   C:\xampp\mysql\bin\mysql.exe -u root -e "CREATE DATABASE nine_to_nine CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; CREATE DATABASE nine_to_nine_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
   ```
3. Install and configure:
   ```
   npm install
   copy .env.example .env      # then set SESSION_SECRET (and DB_PASSWORD if root has one)
   ```
4. Create tables, load the event programme, and create your admin login:
   ```
   npm run seed -- --year 2026
   npm run create-admin -- --email you@example.com --name "Your Name" --role SUPER_ADMIN
   ```
   `seed` applies migrations first. Without `--password`, `create-admin` prints a generated password once.
5. Run it: `npm run dev` → http://localhost:3000 (staff: http://localhost:3000/admin/login)

Tests (they use the separate `nine_to_nine_test` database and wipe it on each run): `npm test`

> The phone camera scanner needs **HTTPS**. On `localhost` it works on the same computer only. For testing on a
> phone before deployment, use the manual registration-number lookup or deploy to Hostinger.

## Configuration

All settings are in `.env` (see [.env.example](.env.example)). The important ones:

- `BASE_URL`: the public address, e.g. `https://register.example.org`. **Every QR code contains it**, so set
  it to the final domain *before* cards are issued.
- `SESSION_SECRET`: a long random string.
- `STORAGE_DIR`: where participant photos are saved. It must be outside the public folder and must survive
  redeploys (see below).
- `TZ_OFFSET`: `+05:30`. All schedule times are stored as event-local wall-clock time.
- In production, `BASE_URL`, `SESSION_SECRET`, `DB_NAME`, `DB_USER` and `DB_PASSWORD` are required. If one is missing, the
  site shows a “not running yet” page naming it. Tables are created and the programme is loaded automatically on
  start (set `AUTO_MIGRATE=false` or `AUTO_SEED=false` to turn that off).

Per-event settings live in the `events` table:

| Column | Meaning |
|---|---|
| `status` | `open` accepts registrations; anything else closes the form |
| `registration_open_at` / `registration_close_at` | optional window |
| `auto_approve` | `1` = registrations are approved immediately; `0` = pending until staff approve |
| `duplicate_rule` | `mobile_name` (default: same mobile + first name + date of birth; siblings may share a phone), `mobile`, `email`, or `none` |
| `allow_overlapping_bookings` | `1` lets a participant book overlapping slots |
| `form_config` | JSON overrides per field, e.g. `{"parish":"optional","diocese":"hidden","email":"required"}` (field names are in [src/fields.js](src/fields.js)) |

Capacities, venues and times are in `activities` / `activity_slots`. Change `activity_slots.capacity` to resize
a slot, or set `status = 'closed'` to stop bookings for it.

## Deploying to Hostinger Business

Hostinger's control panel changes from time to time, so treat the menu names below as a guide.

1. **Database:** hPanel → *Databases* → *MySQL Databases*: create a database and user. Note the database name,
   user and password; use `DB_HOST=127.0.0.1` (not `localhost`, which Node may turn into IPv6 `::1` and MySQL then refuses).
2. **App:** hPanel → *Websites* → add a **Node.js** web app (upload a zip of this folder without `node_modules`,
   or connect a GitHub repository).
   - Node version: 20 or newer
   - Entry file: `server.cjs` · Start command: `npm start`
   - If startup fails, the site shows a "not running yet" page naming the missing setting or database error
3. **Environment variables** (in the Node.js app settings): everything from `.env.example`, with
   `NODE_ENV=production`, the real `BASE_URL`, a new `SESSION_SECRET`, the Hostinger DB credentials, and
   `AUTO_MIGRATE=true`.
4. **Photo storage:** set `STORAGE_DIR` to an absolute path **outside the app's deploy folder**, e.g.
   `/home/<your-user>/nine2nine-storage`, so redeploying doesn't delete uploaded photos.
5. **First-time data** (over SSH, which is included on Business plans; hPanel → *Advanced* → *SSH Access*),
   from the app folder:
   ```
   npm run seed -- --year 2026
   npm run create-admin -- --email you@example.com --name "Your Name" --role SUPER_ADMIN
   ```
6. **HTTPS:** enable the free SSL certificate for the domain. The camera scanner needs it, and secure cookies
   are on in production.
7. **Check the database:** open `https://your-domain/healthz`. It must show `"ok": true`. It tests the database connection,
   every table, migrations, the event programme, an admin account, a test write and photo storage. It reports only
   pass/fail and error codes, never passwords or participant data.
8. Check: open the site, register a test participant, download both cards, log in at `/admin/login`, and scan
   the card with a phone.

## Backups

- **Database:** hPanel backups, plus your own dump before and during the event:
  `mysqldump -u USER -p DBNAME > backup-$(date +%F-%H%M).sql`
- **Photos:** copy the `STORAGE_DIR` folder.
- **Restore:** `mysql -u USER -p DBNAME < backup.sql`, then copy the photos folder back to `STORAGE_DIR`.

## Project layout

```
server.js                 entry point (Hostinger start file)
migrations/001_init.sql   schema
scripts/                  seed, create-admin, migrate
src/app.js                Express setup (helmet CSP, sessions, CSRF locals)
src/fields.js             registration form definition
src/services/             registration + booking, check-in, PDFs, audit
src/routes/               public pages, staff pages
views/                    EJS templates
public/                   CSS and browser JS
test/                     node:test suites (registration, concurrency, check-in, PDFs, HTTP, roles)
```
