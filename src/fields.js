import { eventContent } from './content.js';
import { FORANES } from './parishes.js';

// Registration form definition. Each field's `mode` is its default; an event's
// form_config JSON can override it per field with 'required' | 'optional' | 'hidden'.
// `locked` fields cannot be hidden or made optional because the system depends on them.

export const GENDERS = ['Male', 'Female'];
export const FOOD_PREFERENCES = ['Vegetarian', 'Non-vegetarian', 'Other'];
export const ORGANIZATIONS = ['MAAC', 'Yuvadeepti SMYM', 'CSM', 'Jesus Youth'];
export const COUNTRY_CODES = ['+91', '+971', '+974', '+966', '+965', '+968', '+973', '+44', '+1', '+61', '+64', '+49', '+39'];

export const SECTIONS = [
  { key: 'personal', title: 'Personal information', step: 'Personal' },
  { key: 'contact', title: 'Contact information', step: 'Contact' },
  { key: 'church', title: 'Parish / organization', step: 'Parish' },
  { key: 'emergency', title: 'Emergency contact', step: 'Emergency' },
  { key: 'requirements', title: 'Accommodation & food', step: 'Requirements' },
];

const text = (name, label, section, mode, extra = {}) => ({ name, label, section, mode, type: 'text', max: 100, ...extra });

// cards are printed with Latin fonts, so names must be typed in English letters.
// Used as the server regex and as the input's HTML pattern, so keep it valid in both.
export const LATIN_NAME_PATTERN = "[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ .'\\-]*";

export const FIELDS = [
  // one name field: stored in first_name and printed on the card as typed
  text('first_name', 'Full name (as printed on your card)', 'personal', 'required', { locked: true, autocomplete: 'name', latin: true,
    help: 'Type your name in English letters, exactly as it should appear on your card.' }),
  text('middle_name', 'Middle name', 'personal', 'hidden', { autocomplete: 'additional-name', latin: true }),
  text('last_name', 'Last name', 'personal', 'hidden', { autocomplete: 'family-name', latin: true }),
  text('preferred_name', 'Preferred name (printed on card)', 'personal', 'hidden', { latin: true }),
  { name: 'date_of_birth', label: 'Date of birth', section: 'personal', mode: 'required', type: 'date' },
  { name: 'gender', label: 'Gender', section: 'personal', mode: 'required', type: 'select', options: GENDERS },
  { name: 'profile_photo', label: 'Profile photograph', section: 'personal', mode: 'required', type: 'photo',
    help: 'JPG or PNG, face clearly visible. It is printed on your ID card.' },

  text('mobile', 'Mobile number', 'contact', 'required', { type: 'tel', locked: true, max: 20, autocomplete: 'tel-national', countryCode: true }),
  text('whatsapp', 'WhatsApp number', 'contact', 'optional', { type: 'tel', max: 20, countryCode: true }),
  text('email', 'Email', 'contact', 'optional', { type: 'email', max: 255, autocomplete: 'email' }),
  { name: 'address', label: 'Address', section: 'contact', mode: 'optional', type: 'textarea', max: 500 },
  text('locality', 'Locality', 'contact', 'optional', { max: 150 }),
  text('district', 'District', 'contact', 'required'),
  text('state', 'State', 'contact', 'optional', { default: 'Kerala' }),
  text('pin_code', 'PIN code', 'contact', 'optional', { max: 20, inputmode: 'numeric' }),
  text('country', 'Country', 'contact', 'optional', { default: 'India' }),

  // dropdowns for the Archdiocese of Changanacherry; people from outside it tick
  // "outside_archdiocese" and type both instead
  { name: 'forane', label: 'Forane', section: 'church', mode: 'required', type: 'forane', max: 100, options: FORANES },
  { name: 'parish', label: 'Parish', section: 'church', mode: 'required', type: 'parish', max: 255 },
  text('diocese', 'Diocese', 'church', 'hidden', { max: 255 }),
  // optional: people who belong to none of the movements leave it blank
  { name: 'organization', label: 'Organization you belong to', section: 'church', mode: 'optional', type: 'select', max: 255, options: ORGANIZATIONS },
  text('institution', 'School / College / Institution', 'church', 'hidden', { max: 255 }),
  text('youth_group', 'Youth group', 'church', 'hidden', { max: 255 }),
  text('coordinator_name', 'Coordinator name', 'church', 'hidden', { max: 200 }),
  text('coordinator_mobile', 'Coordinator mobile', 'church', 'hidden', { type: 'tel', max: 20 }),

  text('emergency_name', 'Contact name', 'emergency', 'required', { max: 200, latin: true }),
  text('emergency_relationship', 'Relationship', 'emergency', 'required'),
  text('emergency_mobile', 'Mobile', 'emergency', 'required', { type: 'tel', max: 20 }),
  text('emergency_alternate_mobile', 'Alternate mobile', 'emergency', 'optional', { type: 'tel', max: 20 }),
  text('emergency_email', 'Email', 'emergency', 'optional', { type: 'email', max: 255 }),
  { name: 'emergency_address', label: 'Address', section: 'emergency', mode: 'optional', type: 'textarea', max: 500 },

  { name: 'accommodation_required', label: 'I need accommodation', section: 'requirements', mode: 'hidden', type: 'checkbox' },
  { name: 'arrival_at', label: 'Arrival (date & time)', section: 'requirements', mode: 'hidden', type: 'datetime-local', showIf: 'accommodation_required' },
  { name: 'departure_at', label: 'Departure (date & time)', section: 'requirements', mode: 'hidden', type: 'datetime-local', showIf: 'accommodation_required' },
  { name: 'accommodation_notes', label: 'Special accommodation requirement', section: 'requirements', mode: 'hidden', type: 'textarea', max: 500, showIf: 'accommodation_required' },
  { name: 'food_required', label: 'I need food', section: 'requirements', mode: 'hidden', type: 'checkbox' },
  { name: 'food_preference', label: 'Food preference', section: 'requirements', mode: 'hidden', type: 'select', options: FOOD_PREFERENCES, showIf: 'food_required' },
  { name: 'dietary_notes', label: 'Other dietary requirement', section: 'requirements', mode: 'hidden', type: 'textarea', max: 500, showIf: 'food_required' },
];

export const CONSENTS = [
  { name: 'consent_information', label: 'I confirm that the information provided is correct.', required: true },
  { name: 'consent_rules', label: 'I agree to participate in the 9 TO 9 MEET event and to follow the event rules and instructions.', required: true },
  { name: 'consent_media', label: 'I consent to the use of my photograph/video for event documentation and publicity, subject to the privacy policy.', required: false },
];

/** Returns the field list with the event's overrides applied and hidden fields removed. */
export function formFields(event) {
  const foodOptions = eventContent(event).food_options;
  let overrides = event?.form_config || {};
  if (typeof overrides === 'string') {
    try { overrides = JSON.parse(overrides); } catch { overrides = {}; }
  }
  return FIELDS.map((f) => {
    const o = overrides[f.name];
    const mode = f.locked || !['required', 'optional', 'hidden'].includes(o) ? f.mode : o;
    const options = f.name === 'food_preference' && Array.isArray(foodOptions) && foodOptions.length ? foodOptions : f.options;
    return { ...f, mode, options, required: mode === 'required' };
  }).filter((f) => f.mode !== 'hidden');
}
