import { initializeApp } from "firebase/app";
import {
  Auth,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signOut,
  User,
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

export function signOutUser(): Promise<void> {
  return signOut(auth);
}

// Fires on sign-in, sign-out, page reload (session restore), AND automatic token
// refresh (~hourly). Keeps the app's token fresh so API calls never 401 on expiry.
export function watchAuth(cb: (user: User | null) => void): () => void {
  return onIdTokenChanged(auth, cb);
}

// Map raw Firebase error codes to human messages.
export function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  const map: Record<string, string> = {
    "auth/invalid-email":          "That email address doesn't look right.",
    "auth/user-not-found":         "No account found with that email.",
    "auth/wrong-password":         "Incorrect password. Try again.",
    "auth/invalid-credential":     "Email or password is incorrect.",
    "auth/email-already-in-use":   "An account with this email already exists.",
    "auth/weak-password":          "Password must be at least 6 characters.",
    "auth/too-many-requests":      "Too many attempts. Wait a moment and retry.",
    "auth/network-request-failed": "Network error. Check your connection.",
  };
  return map[code] ?? "Something went wrong. Please try again.";
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
