import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "San Sebastian Café",
    short_name: "San Sebastian",
    description: "Menu, commande et fidélité · Menu, ordering and rewards",
    lang: "fr-CA",
    start_url: "/fr",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f0e6",
    theme_color: "#38251f",
    categories: ["food", "lifestyle"],
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
