// Adapted from IssueTrax: same Firebase primitives, separate configuration and private user paths.
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage } from 'firebase/storage';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';

const env = import.meta.env;
export const configured = Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_STORAGE_BUCKET && env.VITE_FIREBASE_APP_ID);
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  appId: env.VITE_FIREBASE_APP_ID
};
const app = configured ? initializeApp(config) : null;
export const auth = app ? getAuth(app) : null;
// Firestore is authoritative. IndexedDB below is only an upload outbox.
// Avoid persisting private workspace snapshots on shared browsers.
export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;
export const functions = app ? getFunctions(app, env.VITE_FIREBASE_FUNCTIONS_REGION || 'us-central1') : null;
if (app && env.VITE_USE_EMULATORS === 'true') {
  if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') throw new Error('Emulators require localhost.');
  connectAuthEmulator(auth!, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db!, '127.0.0.1', 8080);
  connectStorageEmulator(storage!, '127.0.0.1', 9199);
  connectFunctionsEmulator(functions!, '127.0.0.1', 5001);
}
