import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL(
        "./test/cloudflare-workers.fixture.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["backend/test/*.test.{ts,mjs}"],
    exclude: ["backend/test/*.node.test.ts"],
  },
});
