import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NEXORA — IA pour Facebook Messenger" },
      {
        name: "description",
        content: "Automatisez vos réponses Messenger et commentaires Facebook avec NEXORA.",
      },
      { property: "og:title", content: "NEXORA — IA pour Facebook Messenger" },
      {
        property: "og:description",
        content: "Automatisez vos réponses Messenger et commentaires Facebook avec NEXORA.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
