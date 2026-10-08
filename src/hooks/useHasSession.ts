import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Retourne true seulement quand une session Supabase est disponible côté client.
 * Évite d'appeler les server functions protégées sans jeton (401).
 */
export function useHasSession(): boolean {
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) setHasSession(Boolean(data.session));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(Boolean(session));
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return hasSession;
}
