// Firebase web config (project mile-tracker-mtm). These values are not
// secrets: access is controlled by web/firestore.rules (each user can only
// read and write users/{their uid}/...).
// Set apiKey to "PASTE_ME" to run the app in "this phone only" mode and the
// web map in demo mode.
export const firebaseConfig = {
  apiKey: "AIzaSyDxcOYpyHC-z5TAyXvHTrFzuKLrHxaftT8",
  authDomain: "mile-tracker-mtm.firebaseapp.com",
  projectId: "mile-tracker-mtm",
  storageBucket: "mile-tracker-mtm.firebasestorage.app",
  messagingSenderId: "777163758788",
  appId: "1:777163758788:web:778d30f94567f616f97d91",
};

// Where the web map is published (shown as a link in the phone app).
export const WEB_MAP_URL = "https://mikohub66.github.io/mile-tracker/";
