import { defineConfig } from "vite";
export default defineConfig({
  define: { global: "globalThis" },
  build: { target: "es2022" },
});
