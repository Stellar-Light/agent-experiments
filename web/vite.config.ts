import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  define: { global: "globalThis" },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        demo: resolve(__dirname, "demo/index.html"),
        how: resolve(__dirname, "how/index.html"),
      },
    },
  },
});
