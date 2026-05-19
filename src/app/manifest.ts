import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#05090c",
    description: "A quiet local RSS podcast player.",
    display: "standalone",
    icons: [
      {
        src: "/icons/gopod-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/gopod-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/gopod-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    name: "GoPod",
    short_name: "GoPod",
    start_url: "/",
    theme_color: "#05090c",
  };
}
