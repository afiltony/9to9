// Seeds the 9 TO 9 MEET event, its activities and time slots.
//   npm run seed                 -> year from EVENT_YEAR, or the current year
//   npm run seed -- --year 2027
// Does nothing if the event code already exists (edit it in the database instead).
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { closePool, tx } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { newId } from '../src/services/registration.js';

const argYear = process.argv.indexOf('--year');
const YEAR = Number(argYear > -1 ? process.argv[argYear + 1] : process.env.EVENT_YEAR || new Date().getFullYear());
if (!Number.isInteger(YEAR) || YEAR < 2000) throw new Error('Invalid --year');

/** The activity programme from the event schedule, dated for the given year. */
export function buildActivities(YEAR) {
  const DAY1 = `${YEAR}-10-10`;
  const DAY2 = `${YEAR}-10-11`;

  // [start, end] on day 1 unless the time is marked with "+1" (next day)
  const at = (t) => (t.endsWith('+1') ? `${DAY2} ${t.slice(0, 5)}:00` : `${DAY1} ${t}:00`);
  const slot = (start, end, label = null) => ({ start: at(start), end: at(end), label });
  const hourly = (from, to) => Array.from({ length: to - from }, (_, i) => {
    const h = (n) => String(n).padStart(2, '0');
    return slot(`${h(from + i)}:00`, `${h(from + i + 1)}:00`);
  });

  return [
    { name: 'Registration', venue: 'Reception', capacity: null, requiresSlot: false,
      slots: [slot('09:00', '09:30', 'Show your registration card at reception')] },
    {
      name: 'Music Ministry', venue: 'Central Stage', capacity: 400, requiresSlot: true,
      slots: [
        slot('09:30', '10:00', 'Ceremonial Installation of the Relic and Sacred Image of St. Carlo'),
        slot('10:00', '12:00', 'Music Ministry + Eucharistic Talks'),
        slot('13:00', '15:00', 'Music Ministry + Carlo Talk'),
        slot('15:00', '17:00', 'Music Ministry + Carlo Talk'),
        slot('17:00', '19:00', 'Ruha Band, Cultural Programme'),
      ],
    },
    { name: 'Adoration', venue: 'Incubation Centre', capacity: 30, requiresSlot: true, slots: hourly(10, 19) },
    {
      name: 'Night Vigil', venue: 'Central Stage', capacity: 400, requiresSlot: true, multiSlot: true,
      slots: [slot('19:00', '21:00'), slot('21:00', '23:00'), slot('23:00', '05:00+1'), slot('05:00+1', '07:00+1')],
    },
    { name: 'Rosary Making Workshop', venue: null, capacity: 20, requiresSlot: true, slots: hourly(10, 18) },
    { name: 'Selfie Point Zone', venue: null, capacity: null, requiresSlot: false, slots: [] },
    {
      name: 'Meet with Bishop', venue: null, capacity: 30, requiresSlot: true,
      slots: [
        slot('10:00', '11:00'),
        slot('11:30', '12:30', 'Mar Joseph Pernthottam'),
        slot('14:30', '15:30', 'Cardinal Mar George Alencherry'),
        slot('16:00', '17:00', 'Cardinal Mar George Alencherry'),
      ],
    },
    {
      name: 'Garden of Joy / Confession', venue: null, capacity: 50, requiresSlot: true,
      slots: [...hourly(10, 13), ...hourly(14, 17)],
    },
    { name: 'Theatre', venue: null, capacity: 250, requiresSlot: true, slots: [slot('10:00', '12:00'), slot('13:00', '15:00'), slot('15:00', '17:00')] },
    { name: 'VR Experience Show', venue: null, capacity: 40, requiresSlot: true, slots: hourly(10, 18) },
    // bookable with no limit on places; nothing else runs at the same time
    { name: 'Holy Qurbana', venue: 'Central Stage', capacity: null, requiresSlot: true, slots: [slot('07:00+1', '09:00+1')] },
  ];
}

export async function seed({ year = YEAR, code = config.eventCode, log = console.log } = {}) {
  return tx(async (conn) => {
    const [[existing]] = await conn.query('SELECT id FROM events WHERE event_code = ?', [code]);
    if (existing) {
      log(`Event ${code} already exists — nothing seeded.`);
      return existing.id;
    }
    const eventId = newId();
    await conn.query('INSERT INTO events SET ?', [{
      id: eventId,
      event_code: code,
      name: '9 TO 9 MEET – 24 HOUR GOD EXPERIENCE',
      subtitle: 'Youth Camp Inspired by St. Carlo Acutis',
      tagline: 'Eyes Opened | Hearts on Fire',
      description: 'Eyes Opened | Hearts on Fire — From Emmaus Blindness to Eucharistic Vision (Lk 24:13-35). Come, walk with Him.',
      venue: 'Media Village',
      start_at: `${year}-10-10 09:00:00`,
      end_at: `${year}-10-11 09:00:00`,
      status: 'open',
      help_desk_text: 'For assistance please contact the EVENT HELP DESK or call +91 94969 35651.',
      contact_phone: '+91 94969 35651',
    }]);
    const activities = buildActivities(year);
    let order = 0;
    let slotCount = 0;
    for (const a of activities) {
      const activityId = newId();
      await conn.query('INSERT INTO activities SET ?', [{
        id: activityId, event_id: eventId, name: a.name, venue: a.venue, capacity: a.capacity,
        requires_slot: a.requiresSlot ? 1 : 0, multi_slot: a.multiSlot ? 1 : 0, sort_order: (order += 10),
      }]);
      for (const s of a.slots) {
        await conn.query('INSERT INTO activity_slots SET ?', [{
          id: newId(), activity_id: activityId, label: s.label,
          start_at: s.start, end_at: s.end,
          capacity: a.capacity,
        }]);
        slotCount++;
      }
    }
    log(`Seeded event ${code} for ${year}: ${activities.length} activities, ${slotCount} slots.`);
    return eventId;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await migrate();
  await seed();
  await closePool();
}
