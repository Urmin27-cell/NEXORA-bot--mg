// Auth route updated for Vercel deployment compatibility
import { createFileRoute, useNavigate, useRouter, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Bot, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { lovable } from "@/integrations/lovable/index";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Connexion — NEXORA" },
      { name: "description", content: "Connectez-vous à votre espace NEXORA." },
      { property: "og:title", content: "Connexion — NEXORA" },
      { property: "og:description", content: "Connectez-vous à votre espace NEXORA." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [newPassword, setNewPassword] = useState("");

  useEffect(() => {
    const isRecovery =
      typeof window !== "undefined" &&
      (window.location.hash.includes("type=recovery") ||
        window.location.search.includes("type=recovery"));
    if (isRecovery) setRecovery(true);

    const checkExisting = async () => {
      if (isRecovery) return;
      try {
        const { data } = await supabase.auth.getUser();
        if (data?.user) await navigate({ to: "/dashboard", replace: true });
      } catch (err) {
        console.warn("Auth check error:", err);
      }
    };
    checkExisting();

    let sub: any = null;
    try {
      const res = supabase.auth.onAuthStateChange((event, session) => {
        if (event === "PASSWORD_RECOVERY") setRecovery(true);
        if (event === "SIGNED_IN" && session && !isRecovery) {
          router.invalidate().then(() => navigate({ to: "/dashboard", replace: true }));
        }
      });
      sub = res.data;
    } catch (err) {
      console.warn("Auth state change error:", err);
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "SUPABASE_OAUTH_SUCCESS") {
        toast.success("Connexion Supabase réussie !");
        navigate({ to: "/dashboard" });
      }
    };

    window.addEventListener("message", handleMessage);

    return () => {
      window.removeEventListener("message", handleMessage);
      try {
        sub?.subscription?.unsubscribe?.();
      } catch {}
    };
  }, [navigate, router]);

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = (resetEmail || email).toLowerCase().trim();
    if (!target) {
      toast.error("Veuillez saisir votre e-mail");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(target, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      toast.success("E-mail de réinitialisation envoyé. Vérifiez votre boîte de réception.");
      setForgotOpen(false);
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors de l'envoi de l'e-mail");
    } finally {
      setLoading(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères");
      return;
    }
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast.success("Mot de passe mis à jour !");
      setRecovery(false);
      await router.invalidate();
      await navigate({ to: "/dashboard", replace: true });
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors de la mise à jour du mot de passe");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setLoading(true);
    try {
      const result = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: `${window.location.origin}/auth`,
      });
      if (result.error) throw result.error;
      if (result.redirected) return;
      toast.success("Connexion Google réussie !");
      await router.invalidate();
      await navigate({ to: "/dashboard", replace: true });
    } catch (err: any) {
      toast.error(err?.message || "Erreur lors de la connexion Google");
      setLoading(false);
    }
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      toast.error("Veuillez remplir votre e-mail et mot de passe");
      return;
    }

    const currentKey =
      import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ||
      (typeof process !== "undefined" && process.env?.["SUPABASE_PUBLISHABLE_KEY"]) ||
      "";

    if (!currentKey || currentKey === "dummy-publishable-key" || currentKey.length < 20) {
      toast.error(
        "Clé 'anon public' absente : ajoutez VITE_SUPABASE_PUBLISHABLE_KEY dans Vercel (Settings > Environment Variables) puis faites un Redeploy.",
      );
      return;
    }

    setLoading(true);
    try {
      const normalizedEmail = email.toLowerCase().trim();

      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth` },
        });
        if (error) throw error;
        if (!data.session) {
          toast.success("Compte créé. Confirmez votre adresse e-mail avant de vous connecter.");
          setMode("signin");
          return;
        }
        toast.success("Inscription réussie !");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: normalizedEmail,
          password,
        });
        if (error) throw error;
        toast.success("Connexion réussie !");
      }

      const { data: verified, error: verificationError } = await supabase.auth.getUser();
      if (verificationError || !verified.user) {
        throw verificationError ?? new Error("La session n’a pas pu être vérifiée");
      }
      await router.invalidate();
      await navigate({ to: "/dashboard", replace: true });
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.toLowerCase().includes("invalid api key")) {
        toast.error(
          "Clé API Supabase invalide : Vérifiez que VITE_SUPABASE_PUBLISHABLE_KEY dans Vercel correspond bien à la clé 'anon public' (et non le mot de passe ni la service_role), puis faites un Redeploy.",
        );
      } else {
        toast.error(msg || "Erreur lors de la connexion");
      }
    } finally {
      setLoading(false);
    }
  };

  const hasConfiguredUrl = Boolean(
    import.meta.env["VITE_SUPABASE_URL"] ||
    (typeof process !== "undefined" && process.env?.["SUPABASE_URL"]),
  );
  const hasConfiguredKey = Boolean(
    (import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] &&
      import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] !== "dummy-publishable-key" &&
      import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"].length > 20) ||
    (typeof process !== "undefined" &&
      process.env?.["SUPABASE_PUBLISHABLE_KEY"] &&
      process.env?.["SUPABASE_PUBLISHABLE_KEY"] !== "dummy-publishable-key" &&
      process.env?.["SUPABASE_PUBLISHABLE_KEY"].length > 20),
  );
  const isSupabaseConfigured = hasConfiguredUrl && hasConfiguredKey;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary mb-4">
            <Bot className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-bold gradient-text">NEXORA</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            IA automatique pour Facebook Messenger & commentaires
          </p>
        </div>

        <Card className="glass p-6">
          {!isSupabaseConfigured && (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
              <p className="font-semibold mb-1">Configuration Supabase requise</p>
              <p>
                Pour vous connecter ou créer un compte sur votre déploiement Vercel, ajoutez vos
                variables d'environnement Supabase dans les paramètres de votre projet Vercel :
              </p>
              <ul className="mt-1 list-disc list-inside font-mono text-[11px] text-amber-300">
                <li>VITE_SUPABASE_URL</li>
                <li>VITE_SUPABASE_PUBLISHABLE_KEY</li>
                <li>SUPABASE_SERVICE_ROLE_KEY</li>
              </ul>
            </div>
          )}
          {recovery ? (
            <form onSubmit={handleUpdatePassword} className="space-y-4">
              <div>
                <Label htmlFor="new-password">Nouveau mot de passe</Label>
                <Input
                  id="new-password"
                  type="password"
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 font-semibold"
                disabled={loading}
              >
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Enregistrer le nouveau mot de passe
              </Button>
            </form>
          ) : forgotOpen ? (
            <form onSubmit={handleForgot} className="space-y-4">
              <div>
                <Label htmlFor="reset-email">Email du compte</Label>
                <Input
                  id="reset-email"
                  type="email"
                  required
                  value={resetEmail || email}
                  onChange={(e) => setResetEmail(e.target.value)}
                  placeholder="vous@example.com"
                />
              </div>
              <Button
                type="submit"
                className="w-full bg-primary hover:bg-primary/90 font-semibold"
                disabled={loading}
              >
                {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Envoyer le lien de réinitialisation
              </Button>
              <button
                type="button"
                onClick={() => setForgotOpen(false)}
                className="w-full text-xs text-muted-foreground hover:text-foreground"
              >
                ← Retour à la connexion
              </button>
            </form>
          ) : (
            <>
              <div className="flex gap-2 mb-6 rounded-lg bg-muted p-1">
                <button
                  onClick={() => setMode("signin")}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    mode === "signin" ? "bg-card text-foreground" : "text-muted-foreground"
                  }`}
                >
                  Connexion
                </button>
                <button
                  onClick={() => setMode("signup")}
                  className={`flex-1 rounded-md py-2 text-sm font-medium transition-colors ${
                    mode === "signup" ? "bg-card text-foreground" : "text-muted-foreground"
                  }`}
                >
                  Inscription
                </button>
              </div>

              <form onSubmit={handleEmail} className="space-y-4">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="vous@example.com"
                  />
                </div>
                <div>
                  <Label htmlFor="password">Mot de passe</Label>
                  <Input
                    id="password"
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-primary hover:bg-primary/90 font-semibold"
                  disabled={loading}
                >
                  {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {mode === "signin" ? "Se connecter avec Email" : "Créer un compte Email"}
                </Button>
              </form>

              <div className="flex items-center gap-3 my-4">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">na</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full font-semibold"
                onClick={handleGoogle}
                disabled={loading}
              >
                <svg className="h-4 w-4 mr-2" viewBox="0 0 24 24">
                  <path
                    fill="#4285F4"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                  />
                </svg>
                Continuer avec Google
              </Button>

              {mode === "signin" && (
                <button
                  type="button"
                  onClick={() => {
                    setResetEmail(email);
                    setForgotOpen(true);
                  }}
                  className="mt-4 w-full text-sm text-primary hover:underline"
                >
                  Mot de passe oublié ?
                </button>
              )}
            </>
          )}
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          <Link to="/" className="hover:text-foreground">
            ← Retour
          </Link>
        </p>
      </div>
    </div>
  );
}
