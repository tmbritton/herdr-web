import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("priv/static", { recursive: true });
await build({
  entryPoints: ["frontend/app.ts", "frontend/history.ts"],
  bundle: true,
  minify: true,
  outdir: "priv/static",
  target: "es2022",
});
await copyFile("frontend/index.html", "priv/static/index.html");
await copyFile("frontend/history.html", "priv/static/history.html");
