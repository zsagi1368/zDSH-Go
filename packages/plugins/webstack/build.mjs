/**
 * Cross-platform build driver: spawns the local tsdown CLI with Node directly
 * (resolving the real JS entry from tsdown's package manifest), avoiding
 * Windows `.cmd` shim pitfalls that plain execFileSync of `node_modules/.bin/*`
 * would hit. Configuration lives in tsdown.config.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

const runTsdown = (config) => {
	execFileSync(process.execPath, [binJs, "--config", config], {
		stdio: "inherit",
		cwd: fileURLToPath(new URL("./", import.meta.url)),
	});
};

// Host half first (clean:true wipes lib/), browser half second (clean:false).
runTsdown("tsdown.config.ts");
runTsdown("tsdown.client.config.ts");

// ---- client bundle → ModuleLoader factory handshake -----------------------
// The web server serves exactly one file per plugin
// (/plugins/dsh-webstack/client.js). The app's ModuleLoader expects a single
// load({ id, factory }) expression whose factory receives `require` and
// returns the CJS exports object; tsdown emits plain CJS, so the handshake is
// wrapped around the fresh bundle here (idempotent across rebuilds).
const clientUrl = new URL("./lib/client.js", import.meta.url);
const clientBody = readFileSync(clientUrl, "utf8");
if (!clientBody.includes("__ModuleLoader__")) {
	const banner =
		"window.__ModuleLoader__.load({ id: 'webstack', factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n";
	const footer = "\nreturn module.exports; } });\n";
	writeFileSync(clientUrl, `${banner}${clientBody}${footer}`);
}
