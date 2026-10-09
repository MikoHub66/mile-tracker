// Re-exports the Firebase modular SDK functions the app uses, so esbuild can
// bundle them into one local file (www/vendor/firebase.js) for offline startup.
export { initializeApp } from "firebase/app";
export {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  onIdTokenChanged,
  indexedDBLocalPersistence,
  initializeAuth,
} from "firebase/auth";
export {
  initializeFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
