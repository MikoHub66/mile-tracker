# Mile Tracker: notes for Claude

Standalone project (started 2026-10-09). Don't modify grave-mapper, tree-mapper, PhotoScout
or other Code/ projects. Grave-mapper was the pattern copied (Capacitor + local native plugin +
Firebase + GitHub Pages); its playwright-core install was used read-only for smoke tests.

## What the user asked for
MileIQ-like Android tracker: a trip starts after leaving an address and ends after more than
5 minutes at an address; Leaflet web map filterable per day; uses **Personal, RustyRose, GPRS**;
removal of plane, train, bike, Uber and other trips; yearly-by-month CSV with Vehicle, Date,
Start Time, Starting Address, End Time, Ending Address, Miles, Use; pick and add a vehicle in
the app; edit any field on the web; manual trips on the web; constant background tracking.
Later asked for: "as automated as possible", car Bluetooth to pick the vehicle, Find my car.

Reference repos the user linked (checked 2026-10-09; none has GPS trip detection):
ygllc/MyMileage (GPL-3.0, so no code copied), CodeByAlbert/Mileage-Tracker (MIT; idea taken:
address -> driving distance for manual trips), hargata/lubelog (MIT; idea taken: report
preview with per-month and per-vehicle totals), emiilbjorklund/tripLogger (odometer-photo OCR;
not used, possible future year-start/year-end odometer log).

## Architecture
- `mobile-app/plugins/mile-native` (Java): `TripDetector` (pure state machine, unit tested),
  `Rules` (pure auto-classification, unit tested), `TripService` (location foreground service;
  balanced 30 s while parked, GPS 5 s while driving or probing), `TrackerHub` (singleton;
  persists detector state to prefs, saves trips, Android geocoder, Bluetooth vehicle, parked
  spot), `CloudUploader` (Firestore REST create with documentId = trip id; 409 = already
  there, so web edits are never overwritten; refresh token comes from JS `setCloud`),
  `BluetoothReceiver` (manifest ACL broadcasts), `ActivityReceiver` (IN_VEHICLE -> GPS probe),
  `BootReceiver`.
- `mobile-app/www`: `store.js` merges Firestore trips with native trips not yet uploaded;
  `native.js` has a browser mock of the plugin (it can simulate a trip).
- `web/public/shared/trips.js` is the shared source of truth (CSV, time zones, polyline,
  learnUse). Run `npm run sync:shared`; a test fails if the copies drift.
- Trip doc fields: id, source(auto|manual), vehicleId, vehicle, date (local YYYY-MM-DD),
  tz (IANA), startTs/endTs (ms), start/end Lat/Lng/Address, gpsMiles, miles, use, excluded,
  excludedReason, notes, path (encoded polyline), autoRule, useLocked, btMatched,
  startPlace/endPlace.
- Manual-trip miles come from Nominatim geocoding plus the public OSRM router (no API key).

## Pitfalls already hit
- An idle-state anchor must only be refreshed by stationary fixes. Moving fixes near the anchor
  dragged it along the road (caught by TripDetectorTest).
- JUnit `assertEquals(long, long, delta)` binds to the float overload and loses precision on
  epoch ms. Use `assertTrue(Math.abs(..) <= ..)`.
- PowerShell with `$ErrorActionPreference = "Stop"` plus output redirection treats Gradle's SDK
  XML warning on stderr as fatal. build-apk.ps1 switches to Continue around Gradle.
- Leaflet maps in bottom sheets: delayed fitBounds after the sheet closed threw `_leaflet_pos`.
  Use `afterOpen()` and `animate: false`.

## Deferred: iOS app (decided 2026-10-09)
On hold until the Android app and web platform prove themselves. The plan, if resumed:
- Capacitor iOS platform; same www/ UI; rewrite the native plugin in Swift with the same JS
  API (MileTracker). Detection uses significant-location-change + a geofence around the parked
  spot to wake the app, CMMotionActivity "automotive", and standard updates while driving.
  Car Bluetooth is only visible as the audio route while the app is awake (partial vehicle
  matching).
- No Mac here: build in the cloud (Codemagic or GitHub Actions macOS) and upload to TestFlight.
- Distribution: the $99 individual Apple Developer Program with TestFlight internal testing (just
  the user). Enterprise was ruled out: organisations only, employees only, $299. A web
  app/PWA can't track in the background, so it stays review-only.

## Battery, legal, obfuscation (2026-10-29)
User reported battery drain and asked for legal protection + hiding the key/logic.
- Battery: the 24/7 parked location tier was the drain. New tiered policy in TripService.applyMode
  keyed by `reqKey`: parked+saver -> BALANCED 180s/min120s/maxDelay300s (batched); parked -> 45s;
  driving/probe -> HIGH_ACCURACY 8s (5s if highAccuracyAlways). Ticker is 60s driving / 150s parked.
  Notification only re-posts when its text changes. New pref `batterySaver` (default true, forced
  off when highAccuracyAlways). Settings toggle `#battSaver`; status exposes batterySaver +
  batterySaverSetting. Bluetooth/activity boosts still force GPS instantly, so detection unaffected.
- Legal: single source web/public/shared/legal.js (synced to app). App shows Settings -> Legal &
  privacy and a one-time acceptance sheet gating first-run tracking (mt.legalAccepted). Web shows a
  Legal button + login-screen line. DISCLAIMER.md is generated from the same sections.
- Obfuscation: scripts/pack-assets.mjs runs in build-apk.ps1 AFTER `cap sync`, bundling the APK's
  assets/public/app.js into minified app.min.js and deleting the first-party sources (keeps vendor/
  + leaflet; dynamic import("./vendor/firebase.js") preserved via an esbuild external plugin). www/
  source is untouched so browser preview/dev still works. R8/Java obfuscation was NOT enabled
  (needs a signed release + device testing; risk > value). Told the user: Firebase web key is
  public by design, data safety is the Firestore rules, and the web source stays public because the
  GitHub repo is public (free Pages needs public). Private web source would need a paid plan.

## Status (2026-10-09)
- JS tests 9/9 and native unit tests 10/10 pass. Web Table view (inline + bulk edit, full-table
  CSV) and Esri satellite basemaps were added 2026-10-09. Debug APK builds (`dist/MileTracker-debug.apk`).
- Headless Edge smoke tests passed with no console errors: web demo (classify, edit, remove,
  manual trip, whole month, report and CSV, phone width) and phone UI with the mock tracker
  (vehicle + Bluetooth link, automation config reaching native, places, classify/remove, trip
  map, Find my car).
- Not yet: running on a real phone (background survival, Bluetooth, geocoder).

## MileIQ import (2026-11-19)
User asked to import MileIQ CSV exports to keep their history. No sample export was available,
so the parser is header-driven and tolerant: web/public/shared/mileiq.js (pure, tested in
tests/mileiq.test.mjs) finds the header row in the first 60 lines (needs a date + miles column),
maps columns by alias, parses US M/D/Y, ISO and month-name dates with 12/24 h times, and skips
totals rows. web/public/import.js is the dialog (category -> use, purpose override, vehicle map,
time zone, column override, preview). Trips get source "mileiq", id "mileiq-<fnv hash>" (stable,
so re-imports are no-ops), gpsMiles null, no path. Dups vs existing: same id, or same date, start
within 15 min and miles within max(0.5, 10%). api.importTrips batch-sets 400 per commit. Year
pickers in Report and Table now go back 8 years. If the user's real export doesn't parse, fix the
alias list in FIELDS or use the "Columns found" override.
- User's real export (2025 + 2026 YTD) is the MileIQ "Drives Report": rates line, SUMMARY block of
  spreadsheet formulas, then DETAILED LOG header START_DATE*,END_DATE*,CATEGORY*,START*,STOP*,RATE,
  MILES*,MILES_VALUE,PARKING,TOLLS,TOTAL,VEHICLE,PURPOSE,NOTES; dates "MM/DD/YYYY HH:MM" (24 h).
  Vehicles "Vincent Vango", "Green Machine"; purposes Personal, Business, GPRS, GeNiuSS, Customer Visit.
- Two phones share that MileIQ account, so many drives appear twice (same route, minutes apart),
  and sometimes two people drive at once in different states. findFileDuplicates marks the later of
  a pair (start within 15 min, miles within max(0.5,10%), same start or end name/ZIP) as excluded
  reason "duplicate" (new EXCLUDE_REASONS entry), on by default, restorable. Never commit the real
  CSVs (public repo); tests use made-up addresses.

## Driving GPS pacing (2026-11-19, APK 1.1 / versionCode 2)
User's wife reported the phone getting hot while driving; user suggested logging only at turns and
every 250 ft. Explained that stored points don't cost battery, the GPS radio does, and 250 ft is
MORE frequent than the old 8 s at highway speed. Implemented instead:
- PacePolicy (pure, PacePolicyTest): CITY 8 s; CRUISE 20 s after two fixes >= 45 mph with heading
  within 20 deg; leaves cruise under 35 mph, on a >30 deg heading swing, or unknown speed.
- TripService.applyMode: "gps-always" (5 s, user choice) > driving ("drive:<interval>",
  setMaxUpdateDelayMillis 60 s batching) > probing ("probe", 8 s unbatched) > parked tiers.
  NOTE "Always use GPS" keeps GPS on 24/7 even parked; first thing to check for heat complaints.
- Deferred option 3: gyro/compass-triggered fixes (turn detection by sensors).
- versionCode/versionName live in the generated, gitignored mobile-app/android/app/build.gradle
  (now 2 / "1.1"); bump again there before each APK the user installs over the old one.
  The APK is signed by ~/.android/debug.keystore; same key = in-place upgrade keeps trips.json.
  dist/MileTracker-1.0-backup.apk is the previous build.

## Live setup (2026-10-10)
- Firebase project `mile-tracker-mtm` (created with the user's Firebase CLI login). Firestore
  (default) is in nam5; rules deployed from web/firestore.rules; email/password auth enabled via
  `firebase deploy --only auth` (the "auth" block in web/firebase.json). Web app id
  1:777163758788:web:778d30f94567f616f97d91. Authorized domains were NOT changed, because
  email/password sign-in doesn't need them (only popup/redirect/email-link flows do).
- GitHub repo MikoHub66/mile-tracker (public, like PhotoScout). Pages runs in Actions mode and
  deploys web/public on pushes that touch it: https://mikohub66.github.io/mile-tracker/
- Verified with throwaway accounts (deleted afterwards): sign-up, refresh-token exchange, REST
  create (200) and duplicate (409), rules deny other users and anonymous reads, and the live site
  sign-in, manual trip and table.
- Demo data is still available on the live site with ?demo.
