// Firebase config for this tracker. Replace the values with the config from your Firebase
// project: Firebase console > Project settings > General > Your apps > (web app) > Config.
// These values are not secret: they only say which database to talk to. The access code
// is what protects your data, and it is never stored in this repo.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBepebFPCdL8tv_dKigr-_GXlKiLSY43Ag",
  authDomain: "hodgman-wedding.firebaseapp.com",
  databaseURL: "https://hodgman-wedding-default-rtdb.firebaseio.com",
  projectId: "hodgman-wedding",
  storageBucket: "hodgman-wedding.firebasestorage.app",
  messagingSenderId: "923090168369",
  appId: "1:923090168369:web:5f8f48cb9bd355583bc310"
};

export const FIREBASE_CONFIGURED = FIREBASE_CONFIG.apiKey !== "REPLACE_ME";
