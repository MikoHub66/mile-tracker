// Shared legal text for the web map and the phone app (identical copies; see
// sync-shared). Plain-language disclaimer. This is general protective language,
// not legal advice; have a lawyer review it before relying on it in a dispute.

export const APP_NAME = "Mile Tracker";
export const LEGAL_UPDATED = "October 29, 2026";

/** One line shown under forms/footers. */
export const DISCLAIMER_SHORT =
  "Mileage and locations are automatic estimates and may be wrong or incomplete. Verify before relying on them. Provided “as is,” with no warranty and no liability. Use at your own risk.";

/** Sections rendered in the Legal & Privacy screen. [heading, body] pairs. */
export const LEGAL_SECTIONS = [
  [
    "Estimates only — not a system of record",
    "Mile Tracker detects trips and distances automatically from your phone’s location. These are estimates. They can be wrong, missing, duplicated, or imprecise because of GPS error, loss of signal, a dead or powered-off phone, battery-saver limits, Android closing the app, or other software or hardware behavior beyond our control. You are responsible for reviewing, correcting, and confirming every trip before using it for any purpose. Do not rely on this app as your only record for taxes, reimbursement, billing, or any legal or financial matter. Keep your own independent records where accuracy matters.",
  ],
  [
    "No professional advice",
    "Mile Tracker does not provide tax, accounting, legal, or financial advice. Mileage rules and record-keeping requirements differ by country, state, employer, and situation and change over time. Consult a qualified professional before submitting mileage for deductions, reimbursement, or any official use.",
  ],
  [
    "Provided “as is” — no warranty",
    "This software is provided “as is” and “as available,” without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, accuracy, and non-infringement. We do not warrant that the app will be accurate, reliable, uninterrupted, error-free, or available at any given time.",
  ],
  [
    "Limitation of liability",
    "To the fullest extent allowed by law, the developer is not liable for any direct, indirect, incidental, special, consequential, or punitive damages, or for any lost profits, lost data, missed deductions, denied reimbursements, penalties, fines, or other losses arising from your use of — or inability to use — Mile Tracker, or from any error or omission in its data, even if advised of the possibility. You use the app entirely at your own risk and you are solely responsible for how you use its data.",
  ],
  [
    "Your data and location",
    "Mile Tracker records your location in the background only while automatic tracking is turned on, so it can detect your trips. Trips are stored on your device and, when you sign in, in your own private Google Firebase account that only you can access. Your trip data is not sold and is not shared with the developer or other users. You can edit or delete trips at any time, and turn off tracking at any time. Turning tracking off stops new trips from being recorded.",
  ],
  [
    "Third-party services",
    "The app uses third-party services including Google Firebase (sign-in and storage), Google Play Services (location and activity detection), OpenStreetMap and Esri (map imagery), and, on the web, OpenStreetMap Nominatim and OSRM for looking up addresses and routes for manually entered trips. Those services have their own terms and privacy practices, and we are not responsible for them.",
  ],
  [
    "Acceptance",
    "By turning on tracking or using Mile Tracker, you acknowledge that you have read and agree to this disclaimer. If you do not agree, do not use the app.",
  ],
];

/** Full disclaimer as plain text (used for the repo DISCLAIMER file and exports). */
export function legalPlainText() {
  return (
    `${APP_NAME} — Disclaimer and Terms of Use\nLast updated: ${LEGAL_UPDATED}\n\n` +
    LEGAL_SECTIONS.map(([h, b]) => `${h.toUpperCase()}\n${b}`).join("\n\n") +
    "\n"
  );
}
