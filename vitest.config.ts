import { defineConfig } from "vitest/config";

// Frontend unit tests. jsdom gives appearance.ts a real localStorage +
// document to drive; the pure helpers (command grouping) need nothing from it.
// Tests live next to what they cover as *.test.ts(x).
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
