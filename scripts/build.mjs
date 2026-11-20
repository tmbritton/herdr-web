import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("priv/static", { recursive: true });
await build({
  entryPoints: ["frontend/app.ts"],
  bundle: true,
  minify: true,
  outfile: "priv/static/app.js",
  target: "es2022",
});
await copyFile("frontend/index.html", "priv/static/index.html");
