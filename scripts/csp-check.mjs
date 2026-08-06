/* Layer 2 of the CSP guard (#93).
 *
 * The failure this exists to catch is the worst kind: a blank window on first
 * launch of a RELEASE build, with the cause visible only in the devtools
 * console. Nothing in the existing CI can see it — `cargo test` never loads a
 * webview, `tauri dev` exercises `devCsp` rather than the shipped policy, and
 * `tauri build` proves the bundle compiles and signs, not that it renders.
 *
 * The frontend is static, so it can be verified without Tauri at all:
 *
 *   1. serve `dist/` with the EXACT `Content-Security-Policy` header read from
 *      tauri.conf.json — never a copy, or this rots the first time the policy
 *      changes and nobody updates the test
 *   2. load each entry point in headless Chromium
 *   3. fail on any `securitypolicyviolation` or CSP-related console error
 *   4. assert the page actually rendered — a root element with children, not a
 *      blank body that "loaded fine"
 *
 * ── What this does NOT cover ──
 *
 * Without a Tauri runtime `hasBackend()` is false, so the app renders in mock
 * mode and the IPC bridge is never exercised. `connect-src ipc:` is therefore
 * NOT verified here. That gap is deliberate and accepted: this covers the
 * rendering class of failure, which is what actually produces the blank
 * window. Verifying the bridge needs tauri-driver + WebdriverIO (Linux and
 * Windows only — not supported on macOS), which is issue #93's layer 3.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const CONF = join(ROOT, "src-tauri", "tauri.conf.json");

/** Entry points Tauri can open. All three must load clean. */
const ENTRIES = ["index.html", "popover.html", "terminal.html"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".map": "application/json",
};

async function readCsp() {
  const conf = JSON.parse(await readFile(CONF, "utf8"));
  const csp = conf?.app?.security?.csp;
  if (typeof csp !== "string" || !csp.trim()) {
    throw new Error(`app.security.csp in ${CONF} is ${JSON.stringify(csp)} — expected a policy string`);
  }
  return csp;
}

function serve(csp) {
  const server = createServer((req, res) => {
    // strip the query/hash, then normalize — a served path must not escape dist
    const rel = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      // the whole point: the shipped policy, verbatim
      "Content-Security-Policy": csp,
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

/** A console message that indicates a CSP problem rather than app noise. */
const isCspError = (text) => /content security policy|refused to (load|execute|apply|connect)/i.test(text);

async function main() {
  if (!existsSync(DIST)) {
    throw new Error(`${DIST} does not exist — run \`npm run build\` first`);
  }
  const csp = await readCsp();
  console.log(`policy under test (from tauri.conf.json):\n  ${csp.replace(/;\s*/g, ";\n  ")}\n`);

  const server = await serve(csp);
  const { port } = server.address();
  const browser = await chromium.launch();
  const failures = [];

  for (const entry of ENTRIES) {
    const page = await browser.newPage();
    const problems = [];

    // The event the browser fires for every blocked resource — the
    // authoritative signal, ahead of console text matching.
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (e) => {
        window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || "(inline)"}`);
      });
    });
    page.on("console", (m) => {
      if (m.type() === "error" && isCspError(m.text())) problems.push(`console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

    const url = `http://127.0.0.1:${port}/${entry}`;
    await page.goto(url, { waitUntil: "networkidle" });
    // give React a moment to mount before asking whether anything rendered
    await page.waitForTimeout(500);

    problems.push(...(await page.evaluate(() => window.__cspViolations ?? [])));

    // "Loaded" is not "rendered": a CSP that blocks the bundle still returns a
    // 200 for the HTML and a body with a root element in it. Children are the
    // thing that proves the app ran.
    const rendered = await page.evaluate(() => {
      const root = document.getElementById("root");
      return { hasRoot: !!root, children: root?.childElementCount ?? 0, bodyText: (document.body.innerText ?? "").trim().length };
    });
    if (!rendered.hasRoot) problems.push("no #root element");
    else if (rendered.children === 0 && rendered.bodyText === 0) problems.push("#root is empty — the page rendered blank");

    if (problems.length) {
      failures.push(`${entry}:\n    ${problems.join("\n    ")}`);
      console.log(`  ✕ ${entry}`);
    } else {
      console.log(`  ✓ ${entry} — rendered ${rendered.children} root child element(s), no CSP violations`);
    }
    await page.close();
  }

  await browser.close();
  server.close();

  if (failures.length) {
    console.error(`\nCSP check failed:\n\n  ${failures.join("\n\n  ")}\n`);
    console.error("The production policy blocks something the app needs. Fix the policy in");
    console.error("src-tauri/tauri.conf.json, or the code that depends on what it blocks.\n");
    process.exit(1);
  }
  console.log(`\nAll ${ENTRIES.length} entry points render clean under the production CSP.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
