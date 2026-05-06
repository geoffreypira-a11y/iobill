import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "IO BILL — Facturation & Compta",
        short_name: "IO BILL",
        description: "Le bijou de l'entrepreneur 2.0 — facturation, devis, TVA, URSSAF, compta",
        theme_color: "#0b0c10",
        background_color: "#0b0c10",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"]
      }
    })
  ],
  server: { port: 5173 }
});
