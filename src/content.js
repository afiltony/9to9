// Editable site content. Defaults come only from the organizers' schedule and poster;
// admins override any key in Settings (stored in events.content JSON).

export const DEFAULT_CONTENT = {
  theme: {
    primary: '#ce2029',
    secondary: '#ffb627',
  },
  hero_kicker: 'Youth Camp Inspired by St. Carlo Acutis',
  hero_theme: 'Eyes Opened | Hearts on Fire',
  intro_title: 'A 24-hour experience',
  intro_text: 'From Emmaus Blindness to Eucharistic Vision (Lk 24:13–35). Come, walk with Him — twenty-four hours of prayer, music, conversation and community, from 9 AM on 10 October to 9 AM on 11 October.',
  features: [
    { title: 'Faith', text: 'Adoration, Garden of Joy (Confession), the Night Vigil and Holy Qurbana.' },
    { title: 'Music', text: 'Music Ministry & Talk at the Central Stage, Ruha Band and the cultural programme.' },
    { title: 'Community', text: 'Life of St. Carlo & Eucharistic Miracles, Blood Donation, and a day and night together with young people.' },
    { title: 'Experience', text: 'VR Experience Show, Rosary Making Workshop and the Selfie Point.' },
  ],
  organizers: 'Organized by Media Village, Media Apostolate, Archeparchy of Changanassery | In association with Yuvadeepti SMYM, Jesus Youth and CSM (Catholic Students Movement)',
  card_instruction: 'Please carry this card throughout the event.',
  privacy_text: `We collect the details on the registration form only to organize the event: to confirm your registration, book your activity places, print your participant cards, contact you or your emergency contact, and plan food and accommodation.

Your photograph is printed on your ID card and shown to event staff at check-in. It is not published. If you gave media consent, photographs and video taken during the event may be used for event documentation and publicity.

Your information is stored securely and is accessible only to authorized event staff. It is not sold or shared with third parties. To see, correct or delete your information, contact the organizers.

[This text must be reviewed and approved by the event organizers.]`,
  terms_text: `By registering you confirm that the information you provided is correct and that you will follow the instructions of the event organizers and volunteers.

Activity places are limited and are allocated first come, first served. Please attend the activities you booked at the time shown on your activity card, and carry your participant card throughout the event.

Participants under 18 should register with the knowledge and consent of a parent or guardian.

The organizers may change the programme, venues or times if necessary.

[This text must be reviewed and approved by the event organizers.]`,
};

export function eventContent(event) {
  let saved = event?.content || {};
  if (typeof saved === 'string') {
    try { saved = JSON.parse(saved); } catch { saved = {}; }
  }
  return {
    ...DEFAULT_CONTENT,
    ...saved,
    theme: { ...DEFAULT_CONTENT.theme, ...(saved.theme || {}) },
    features: Array.isArray(saved.features) && saved.features.length ? saved.features : DEFAULT_CONTENT.features,
  };
}
