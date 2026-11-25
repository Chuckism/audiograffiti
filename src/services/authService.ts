// Simplified from IssueTrax. Anyone can create their own private workspace; no team approval.
import { browserLocalPersistence, createUserWithEmailAndPassword, GoogleAuthProvider, setPersistence, signInWithEmailAndPassword, signInWithPopup, signOut, updateProfile, sendPasswordResetEmail } from 'firebase/auth';
import { auth } from '../firebase';
function requireAuth() {
  if (!auth) throw new Error('The cloud workspace is not connected yet.');
  return auth;
}
export async function loginWithGoogle() {
  const service = requireAuth();
  await setPersistence(service, browserLocalPersistence);
  return signInWithPopup(service, new GoogleAuthProvider());
}
export async function emailLogin(email: string, password: string, name?: string) {
  const service = requireAuth();
  await setPersistence(service, browserLocalPersistence);
  if (name !== undefined) {
    const result = await createUserWithEmailAndPassword(service, email, password);
    await updateProfile(result.user, { displayName: name.trim() });
    return result;
  }
  return signInWithEmailAndPassword(service, email, password);
}
export const resetPassword = (email: string) => sendPasswordResetEmail(requireAuth(), email);
export const logout = () => signOut(requireAuth());
