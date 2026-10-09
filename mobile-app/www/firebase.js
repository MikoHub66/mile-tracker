// Firebase is optional: without a real config the app runs in "this phone only"
// mode (trips stay in the native store). Firestore uses a persistent local
// cache so trips stay readable and editable with no signal.

import { firebaseConfig } from "./shared/firebase-config.js";

export const configured = Boolean(firebaseConfig.apiKey) && firebaseConfig.apiKey !== "PASTE_ME";

export let fb = null;
export let auth = null;
export let db = null;

if (configured) {
  fb = await import("./vendor/firebase.js");
  const app = fb.initializeApp(firebaseConfig);
  auth = fb.initializeAuth(app, { persistence: fb.indexedDBLocalPersistence });
  db = fb.initializeFirestore(app, {
    localCache: fb.persistentLocalCache({ tabManager: fb.persistentSingleTabManager() }),
  });
}

export { firebaseConfig };
