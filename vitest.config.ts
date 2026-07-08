import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Vitest is scoped to pure-function tests only for now — the forecast
// engine is the first one. Includes are narrow so a stray test file
// under app/ doesn't accidentally run Remix loader / DB code without
// a mocked environment.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/services/forecast/**/*.test.ts"],
  },
});
