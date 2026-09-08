/**
 * Cross-platform build driver: spawns the local tsdown CLI with Node directly
 * (resolving the real JS entry from tsdown's package manifest), avoiding
 * Windows `.cmd` shim pitfalls that plain execFileSync of `node_modules/.bin/*`
 * would hit. Same shape as packages/bridge/build.mjs — this satellite is
 * host-side only and has no browser half.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("tsdown/package.json");
const manifest = JSON.parse(readFileSync(pkgPath, "utf8"));

const binField =
	typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.tsdown;
if (binField === undefined) {
	console.error(
		"build.mjs: cannot locate the tsdown binary entry in its package.json",
	);
	process.exit(1);
}

const binJs = fileURLToPath(
	new URL(binField, pathToFileURL(resolve(dirname(pkgPath), "_"))),
);

execFileSync(process.execPath, [binJs, "--config", "tsdown.config.ts"], {
	stdio: "inherit",
	cwd: fileURLToPath(new URL("./", import.meta.url)),
});
