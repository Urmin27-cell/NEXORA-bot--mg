import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/reset-password")({
  head: () => ({
    meta: [
      { title: "Nouveau mot de passe — NEXORA" },
      { name: "description", content: "Créez un nouveau mot de passe pour votre compte NEXORA." },
      { property: "og:title", content: "Nouveau mot de passe — NEXORA" },
      {
        property: "og:description",
        content: "Créez un nouveau mot de passe pour votre compte NEXORA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [validRecovery, setValidRecovery] = useState(false);

  useEffect(() => {
    const recoveryInUrl =
      window.location.hash.includes("type=recovery") ||
      window.location.search.includes("type=recovery");
    setValidRecovery(recoveryInUrl);

    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setValidRecovery(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!validRecovery) {
      toast.error("Ce lien de réinitialisation est invalide ou expiré.");
      return;
    }
    if (password.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères.");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("Les mots de passe ne correspondent pas.");
      return;
    }

    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      toast.success("Votre mot de passe a été mis à jour.");
      await router.invalidate();
      await navigate({ to: "/dashboard", replace: true });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Impossible de modifier le mot de passe.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            <KeyRound className="h-7 w-7" />
          </div>
          <h1 className="text-3xl font-bold gradient-text">NEXORA</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Choisissez votre nouveau mot de passe
          </p>
        </div>

        <Card className="glass p-6">
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="password">Nouveau mot de passe</Label>
              <Input
                id="password"
                type="password"
                minLength={6}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="confirm-password">Confirmer le mot de passe</Label>
              <Input
                id="confirm-password"
                type="password"
                minLength={6}
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || !validRecovery}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Enregistrer le nouveau mot de passe
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
