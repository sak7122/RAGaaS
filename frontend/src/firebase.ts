import { initializeApp } from "firebase/app";
import {
  Auth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  UserCredential,
} from "firebase/auth";

const USE_EMULATOR = import.meta.env.VITE_FIREBASE_USE_EMULATOR === "true";
const PROJECT_ID   = import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "ragaas-local";

const app = initializeApp(
  USE_EMULATOR
    ? {
        apiKey:    "local-dev-key",
        authDomain: `${PROJECT_ID}.firebaseapp.com`,
        projectId:  PROJECT_ID,
        appId:     "1:000000000:web:ragaas-local",
      }
    : {
        apiKey:    import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId:  PROJECT_ID,
        appId:     import.meta.env.VITE_FIREBASE_APP_ID,
      }
);

export const auth: Auth = getAuth(app);

if (USE_EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}

// Dev-only: auto sign-in for hardcoded tenant emails against emulator
const DEV_PASSWORD = "local-ragaas-password";

export async function signInWithPassword(email: string, password: string): Promise<UserCredential> {
  return signInWithEmailAndPassword(auth, email, password);
}

export async function signUpWithPassword(email: string, password: string): Promise<UserCredential> {
  return createUserWithEmailAndPassword(auth, email, password);
}

// Used only in dev/emulator mode — auto-creates accounts with fixed password
export async function devSignInTenant(email: string): Promise<string> {
  if (!USE_EMULATOR) {
    throw new Error("devSignInTenant is only available in emulator mode");
  }
  try {
    const r = await signInWithEmailAndPassword(auth, email, DEV_PASSWORD);
    return r.user.getIdToken();
  } catch {
    const r = await createUserWithEmailAndPassword(auth, email, DEV_PASSWORD);
    return r.user.getIdToken();
  }
}
