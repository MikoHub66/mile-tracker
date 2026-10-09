# Mile Tracker

A MileIQ-style mileage tracker: an Android app that records drives on its own in
the background, plus a web map for reviewing and editing them and for downloading
CSV reports.

- **Phone app** (`mobile-app/`, Capacitor + a native Java plugin): detects drives, picks
  the vehicle from your car's Bluetooth, classifies trips automatically, and has a
  Find my car button.
- **Web map** (`web/public/`, Leaflet, GitHub Pages): a month calendar with a day
  filter, every field editable, manual trips, and a yearly or monthly CSV report.
- **Sync**: Firebase Auth + Firestore (`users/{uid}/trips|vehicles|settings`).

## How a trip is recorded

1. While you're parked, the phone checks location every 30 s using Wi-Fi and cell
   (low power).
2. A **trip starts** when you move more than 250 m from where you were parked, or
   more than 100 m at driving speed. GPS also switches on early when your car's
   Bluetooth connects or when Android's activity recognition reports "in vehicle".
3. While driving, GPS records every 5 s.
4. The **trip ends** once you've stayed within 150 m of one spot for **5 minutes**.
   The end time is when you arrived, not 5 minutes later. If GPS is lost for 10
   minutes (parking garage, dead phone), the trip ends at the last known point.
5. Discarded automatically: trips under 0.3 mi and walks (never faster than 13 mph).
6. The start and end addresses come from the phone's geocoder. The trip uploads
   straight to Firestore, even with the app closed.

## Automation

| What | How |
|---|---|
| Which vehicle | Link each vehicle to its car stereo (Settings → Vehicles). A drive with that stereo connected is assigned to that vehicle; otherwise the vehicle picked at the top of the app is used. |
| Not-a-car trips | Optional "Only count drives in my cars": drives with no linked car Bluetooth are removed as *Passenger* (one tap to restore). Trips averaging over about 112 mph are removed as *Plane*. |
| Places | Save places such as Home or the GPRS office, each with a use. A drive to or from a business place is classified automatically. |
| Vehicle default | A vehicle can always be GPRS, for example a company truck. |
| Work hours | Classify drives that start inside set days and hours. |
| Learning | When 2 or more earlier trips on the same route (either direction) were all given the same use, new ones get it too. |
| Find my car | Saves where your car's Bluetooth disconnected (most precise), or where the last drive ended. Shows the distance and opens walking directions. |

Anything classified automatically shows an "auto" tag so you can review it.

## Report (web → Report / CSV)

Pick a year, a month or the whole year by month, a use filter (All / Business /
RustyRose / GPRS / Personal), and a vehicle. The preview shows miles per month per
use plus per-vehicle totals. The CSV columns are
`Vehicle, Date, Start Time, Starting Address, End Time, Ending Address, Miles, Use`.
Monthly subtotal rows and totals are optional. Removed trips are never included.

## Setup

### 1. Firebase (once)
1. Create a Firebase project (console.firebase.google.com). Add a **Web app**, enable
   **Authentication → Email/Password**, and create a **Firestore** database.
2. Paste the web config into `web/public/shared/firebase-config.js` (`firebaseConfig`).
   Also set `WEB_MAP_URL` to the GitHub Pages address.
3. Deploy the rules: `cd web && firebase deploy --only firestore --project <id>`.
4. In Authentication → Settings → Authorized domains, add `<user>.github.io`.

Until step 2 is done, the app runs in "this phone only" mode and the web map shows demo data.

### 2. Web map
Push to GitHub and enable Pages with Settings → Pages → Source: GitHub Actions.
`.github/workflows/deploy-pages.yml` publishes `web/public/`.

### 3. Phone app
```powershell
.\build-apk.ps1        # -> dist\MileTracker-debug.apk
```
Install it on the phone and open it. Then:
1. Allow location, choose **"Allow all the time"**, and allow physical activity,
   nearby devices (Bluetooth) and notifications.
2. Set the battery setting to **Unrestricted** (Settings → Permissions). Samsung and
   Xiaomi phones also need the app excluded from their own sleeping-apps lists.
3. Add vehicles and link them to the car Bluetooth. Save your places.
4. Sign in with the same account as the web map.

## Development

```powershell
cd mobile-app
npm install
npm run sync:shared   # web/public/shared -> mobile-app/www/shared (edit shared code in web/)
npm test              # JS tests (CSV, time zones, polyline, learning)
cd android; .\gradlew.bat :mile-native:testDebugUnitTest   # trip detector + rules tests
```
The phone UI also runs in a desktop browser with a mock tracker (Settings → "Simulate a
finished drive"). Serve `mobile-app/www` after `npm run prepare:vendor`.
