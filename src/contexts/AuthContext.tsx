// Auth state subscription adapted from IssueTrax; private workspace is identified by uid.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { auth } from '../firebase';
const AuthContext = createContext<{user: User | null; loading: boolean}>({ user: null, loading: true });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, user => { setUser(user); setLoading(false); });
  }, []);
  return <AuthContext.Provider value={{user, loading}}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
