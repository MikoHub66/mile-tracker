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

## Status (2026-10-09)
- JS tests 9/9 and native unit tests 10/10 pass. Web Table view (inline + bulk edit, full-table
  CSV) and Esri satellite basemaps were added 2026-10-09. Debug APK builds (`dist/MileTracker-debug.apk`).
- Headless Edge smoke tests passed with no console errors: web demo (classify, edit, remove,
  manual trip, whole month, report and CSV, phone width) and phone UI with the mock tracker
  (vehicle + Bluetooth link, automation config reaching native, places, classify/remove, trip
  map, Find my car).
- Not yet: running on a real phone (background survival, Bluetooth, geocoder).

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
