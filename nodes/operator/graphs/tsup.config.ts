import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: false,
  sourcemap: true,
  platform: "node",
  external: ["@cogni/langgraph-graphs"],
});
