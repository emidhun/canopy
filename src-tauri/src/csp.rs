// Layer 1 of the CSP guard (see .github/workflows/ci.yml and #93).
//
// `cargo check`, `clippy` and `cargo test` never load a webview, so nothing in
// the Rust test suite can prove the production Content-Security-Policy lets
// the app render. What it CAN prove is that the policy still exists and still
// contains the directives the app is known to depend on — which catches the
// most likely regression by far: someone loosening, gutting or deleting the
// policy while debugging and not putting it back.
//
// The stronger check (does it actually render?) is layer 2, a headless
// Chromium load under this exact policy. See `scripts/csp-check.mjs`.

/// The shipped Tauri config, read from source rather than embedded, so this
/// test fails on the *current* file rather than on whatever was compiled in.
#[cfg(test)]
fn tauri_conf() -> serde_json::Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let txt = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&txt).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::tauri_conf;

    /// Directives the app depends on, and why. Each entry is
    /// (directive, required-source, what breaks without it).
    const REQUIRED: &[(&str, &str, &str)] = &[
        ("default-src", "'self'", "everything not covered by a more specific directive"),
        ("script-src", "'self'", "the bundled JS, including Tauri's injected IPC bootstrap"),
        // xterm.js and the design system both set inline styles at runtime;
        // without this the terminal and every themed surface render unstyled.
        ("style-src", "'unsafe-inline'", "xterm.js and runtime theming set inline styles"),
        // the app icon set and terminal glyph atlas are data: / blob: URLs
        ("img-src", "data:", "inline SVG icons and the WebGL glyph atlas"),
        ("font-src", "data:", "the bundled woff2 faces"),
        // the IPC bridge: without it every command call is blocked and the app
        // renders but can do nothing
        ("connect-src", "ipc:", "the Tauri IPC bridge"),
    ];

    #[test]
    fn production_csp_exists_and_keeps_the_directives_the_app_needs() {
        let conf = tauri_conf();
        let csp = conf
            .pointer("/app/security/csp")
            .unwrap_or_else(|| panic!("app.security.csp is missing — the production policy must not be removed"));

        let csp = csp.as_str().unwrap_or_else(|| {
            panic!("app.security.csp is {csp} — `null` disables the policy entirely, which ships an app with no CSP")
        });
        assert!(!csp.trim().is_empty(), "app.security.csp is empty");

        for (directive, source, why) in REQUIRED {
            let found = csp
                .split(';')
                .map(str::trim)
                .find(|d| d.split_whitespace().next() == Some(directive))
                .unwrap_or_else(|| panic!("CSP is missing `{directive}` — needed for {why}\npolicy: {csp}"));
            assert!(
                found.split_whitespace().any(|t| t == *source),
                "CSP `{directive}` no longer allows `{source}` — needed for {why}\nfound: {found}"
            );
        }
    }

    /// `worker-src` is unset and therefore inherits `default-src 'self'`. The
    /// issue flags this as the fragile spot: a bundler chunking strategy or a
    /// library upgrade that introduces a `blob:` worker would break silently,
    /// at runtime, in a release build only.
    ///
    /// This test does not require `worker-src` — it pins the CURRENT state, so
    /// that adding one is a deliberate edit here rather than an accident.
    #[test]
    fn worker_src_inheritance_is_deliberate() {
        let conf = tauri_conf();
        let csp = conf.pointer("/app/security/csp").and_then(|c| c.as_str()).unwrap_or_default();
        let has_worker_src = csp.split(';').map(str::trim).any(|d| d.split_whitespace().next() == Some("worker-src"));
        assert!(
            !has_worker_src,
            "worker-src was added to the CSP. That may be correct — but update this test and \
             confirm scripts/csp-check.mjs still passes, since workers are exactly the case \
             layer 1 cannot verify."
        );
    }

    /// The dev policy is a superset for the dev server; it must never be the
    /// one that ships, and it must not be missing (a dev build with the
    /// production policy cannot reach the Vite HMR socket).
    #[test]
    fn dev_csp_is_separate_from_the_production_one() {
        let conf = tauri_conf();
        let prod = conf.pointer("/app/security/csp").and_then(|c| c.as_str()).unwrap_or_default();
        let dev = conf
            .pointer("/app/security/devCsp")
            .and_then(|c| c.as_str())
            .expect("app.security.devCsp is missing — `npm run tauri dev` would run under the production policy");
        assert_ne!(prod, dev, "devCsp and csp are identical — one of them is wrong");
        assert!(
            !prod.contains("localhost:1420"),
            "the PRODUCTION policy allows the Vite dev server; devCsp was probably copied over it\npolicy: {prod}"
        );
    }
}
