import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
  DocumentData,
  QuerySnapshot,
  DocumentSnapshot,
} from 'firebase/firestore';
import {
  getAuth,
  GoogleAuthProvider,
  FacebookAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
} from 'firebase/auth';
import {
  getStorage,
  ref as storageRef,
  uploadString,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';
import firebaseConfigJson from '../../firebase-applet-config.json';

// Priority 1: import.meta.env (Render / Custom production build env variables)
// Priority 2: firebase-applet-config.json (AI Studio provisioned project config)
const rawApiKey = (
  (import.meta.env.VITE_FIREBASE_API_KEY as string) ||
  firebaseConfigJson.apiKey ||
  ''
).trim();

// Check if a live, valid Firebase API key has been supplied
export const isFirebaseConfigured = Boolean(
  rawApiKey &&
  rawApiKey !== 'demo-api-key' &&
  !rawApiKey.toLowerCase().includes('dummy') &&
  !rawApiKey.toLowerCase().includes('your_') &&
  !rawApiKey.toLowerCase().includes('placeholder') &&
  rawApiKey.length > 20
);

export const defaultFirebaseConfig = {
  apiKey: rawApiKey || 'AIzaSyDemoPlaceholderKeyForLocalDevOnly00',
  authDomain:
    (import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string) ||
    firebaseConfigJson.authDomain ||
    'yielding-drake-lvxch.firebaseapp.com',
  projectId:
    (import.meta.env.VITE_FIREBASE_PROJECT_ID as string) ||
    firebaseConfigJson.projectId ||
    'yielding-drake-lvxch',
  storageBucket:
    (import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string) ||
    firebaseConfigJson.storageBucket ||
    'yielding-drake-lvxch.firebasestorage.app',
  messagingSenderId:
    (import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string) ||
    firebaseConfigJson.messagingSenderId ||
    '399137617746',
  appId:
    (import.meta.env.VITE_FIREBASE_APP_ID as string) ||
    firebaseConfigJson.appId ||
    '1:399137617746:web:b03625b176096da1012c8b',
  measurementId:
    (import.meta.env.VITE_FIREBASE_MEASUREMENT_ID as string) ||
    firebaseConfigJson.measurementId ||
    '',
};

// Initialize or reuse Firebase App instance
const app = getApps().length > 0 ? getApp() : initializeApp(defaultFirebaseConfig);
export const auth = getAuth(app);

// Use specified custom Firestore database ID if provided, otherwise default
const customDbId =
  (import.meta.env.VITE_FIREBASE_FIRESTORE_DATABASE_ID as string) ||
  firebaseConfigJson.firestoreDatabaseId;

function initFirestoreInstance() {
  const settings: any = {
    experimentalForceLongPolling: true,
  };
  try {
    if (typeof window !== 'undefined') {
      settings.localCache = persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      });
    }
  } catch (_) {}

  try {
    if (customDbId && customDbId !== '(default)') {
      return initializeFirestore(app, settings, customDbId);
    }
    return initializeFirestore(app, settings);
  } catch (_) {
    // If initializeFirestore fails or already called, retrieve existing instance
    return customDbId && customDbId !== '(default)'
      ? getFirestore(app, customDbId)
      : getFirestore(app);
  }
}

export const db = initFirestoreInstance();

export const storage = getStorage(app);

/**
 * Creates and configures a fresh GoogleAuthProvider instance.
 * Setting `prompt: 'select_account'` forces Google OAuth to display the account chooser
 * every time, allowing the user to select an account or switch to a different Google account.
 */
export const createGoogleAuthProvider = (): GoogleAuthProvider => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({
    prompt: 'select_account',
  });
  provider.addScope('email');
  provider.addScope('profile');
  return provider;
};

/**
 * Creates and configures a fresh FacebookAuthProvider instance.
 */
export const createFacebookAuthProvider = (): FacebookAuthProvider => {
  const provider = new FacebookAuthProvider();
  provider.addScope('email');
  provider.addScope('public_profile');
  provider.setCustomParameters({
    display: 'popup',
  });
  return provider;
};

export const googleProvider = createGoogleAuthProvider();
export const facebookProvider = createFacebookAuthProvider();

export {
  // Auth primitives
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  onAuthStateChanged,
  GoogleAuthProvider,
  type FirebaseUser,
  
  // Storage primitives
  storageRef,
  uploadString,
  uploadBytes,
  getDownloadURL,
  deleteObject,

  // Firestore primitives
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  deleteDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
  type DocumentData,
  type QuerySnapshot,
  type DocumentSnapshot,
};

