// Firebase config for this tracker. Replace the values with the config from your Firebase
// project: Firebase console > Project settings > General > Your apps > (web app) > Config.
// These values are not secret: they only say which database to talk to. The access code
// is what protects your data, and it is never stored in this repo.
export const FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  databaseURL: "https://REPLACE_ME-default-rtdb.firebaseio.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.firebasestorage.app",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME"
};

export const FIREBASE_CONFIGURED = FIREBASE_CONFIG.apiKey !== "REPLACE_ME";
