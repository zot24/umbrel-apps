#!/usr/bin/env node
// One-shot CLI: convert a Netscape `cookies.txt` (the format exported by
// "EditThisCookie", "Get cookies.txt LOCALLY", curl's `-c`, etc.) into a
// Playwright `storageState.json` that the renderer mounts at
// /data/storageState.json when a client requests `useSession: true`.
//
// Operator runs this LOCALLY on the machine where the cookies.txt lives.
// The output JSON is then scp'd to the Umbrel volume — see STORAGESTATE.md
// for the full ritual. Intentionally zero deps (Node stdlib only) so this
// can be invoked from a bare shell without `npm install`.
//
// Usage:
//   node tools/cookies-to-storage-state.mjs <cookies.txt> <out-storageState.json>
//
// Sanity check (optional 3rd arg): pass `--require sessionid,ds_user_id`
// to fail loud if any of the named cookies aren't in the input. For
// Instagram you almost always want both — without `sessionid` the session
// is anonymous and the renderer wastes time; this guard catches a stale
// export that's already logged out.

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const positional = [];
  let requireList = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--require") {
      requireList = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    positional.push(a);
  }
  return { positional, requireList };
}

function usage() {
  return [
    "Usage: node tools/cookies-to-storage-state.mjs <cookies.txt> <out.json> [--require name1,name2,...]",
    "",
    "Converts a Netscape cookies.txt export to a Playwright storageState.json file.",
    "Run locally where the cookies.txt lives; scp the output to /data/storageState.json",
    "on the Umbrel renderer volume. See STORAGESTATE.md for the full ritual.",
    "",
    "Example (Instagram):",
    "  node tools/cookies-to-storage-state.mjs ~/Desktop/instagram_cookies.txt ./storageState.json \\",
    "      --require sessionid,ds_user_id",
  ].join("\n");
}

// Netscape cookies.txt is tab-separated:
//   domain  includeSubdomains  path  secure  expires  name  value
// Lines starting with `#` are comments. The `#HttpOnly_` prefix on the
// domain field is a Mozilla convention for HttpOnly cookies — strip it
// and set httpOnly=true. Everything else is permissive.
function parseNetscapeCookies(text) {
  const cookies = [];
  const skipped = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    // Comments are `#` UNLESS it's the HttpOnly marker convention.
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;

    const parts = line.split("\t");
    if (parts.length < 7) {
      skipped.push({ reason: "<7 fields", raw });
      continue;
    }

    let [domainField, includeSubdomains, cookiePath, secure, expires, name, ...rest] = parts;
    // value may itself contain tabs (rare but legal in some exporters);
    // rejoin everything after the 6th field.
    const value = rest.join("\t");

    let httpOnly = false;
    let domain = domainField;
    if (domain.startsWith("#HttpOnly_")) {
      httpOnly = true;
      domain = domain.slice("#HttpOnly_".length);
    }

    if (!name) {
      skipped.push({ reason: "empty name", raw });
      continue;
    }

    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || "/",
      // Playwright wants seconds-since-epoch as a number; -1 means session.
      // Netscape uses 0 for session cookies sometimes — normalise to -1.
      expires: Number(expires) > 0 ? Number(expires) : -1,
      httpOnly,
      secure: secure === "TRUE",
      // Netscape format doesn't encode sameSite; "Lax" matches what
      // Chromium uses as default for new cookies and won't break anything
      // for first-party reads.
      sameSite: "Lax",
    });
  }
  return { cookies, skipped };
}

function main() {
  const { help, positional, requireList } = parseArgs(process.argv);
  if (help || !positional || positional.length !== 2) {
    process.stderr.write(usage() + "\n");
    process.exit(help ? 0 : 2);
  }
  const [inputPath, outputPath] = positional;

  if (!fs.existsSync(inputPath)) {
    process.stderr.write(`Input file not found: ${inputPath}\n`);
    process.exit(2);
  }

  const text = fs.readFileSync(inputPath, "utf8");
  const { cookies, skipped } = parseNetscapeCookies(text);

  if (cookies.length === 0) {
    process.stderr.write(
      `Parsed 0 cookies from ${inputPath} — wrong format? Expected Netscape cookies.txt (tab-separated)\n`
    );
    process.exit(1);
  }

  if (requireList && requireList.length > 0) {
    const names = new Set(cookies.map((c) => c.name));
    const missing = requireList.filter((r) => !names.has(r));
    if (missing.length > 0) {
      process.stderr.write(
        `Missing required cookie(s): ${missing.join(", ")} — re-export ` +
          `the cookies.txt while you're logged in to the target site.\n`
      );
      process.exit(1);
    }
  }

  const storageState = {
    cookies,
    // We don't carry localStorage / sessionStorage in the Netscape format,
    // so `origins` stays empty. Playwright is happy with that — cookies
    // alone are enough for an Instagram public-profile session.
    origins: [],
  };

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(storageState, null, 2));
  // Restrict on the output side too — mode 600. The operator's scp will
  // preserve permissions (`scp -p` does, but plain `scp` may not), so the
  // restrictive ACL on the source side is a sane belt-and-suspenders.
  try {
    fs.chmodSync(outputPath, 0o600);
  } catch {}

  const domains = new Set(cookies.map((c) => c.domain));
  process.stdout.write(
    `Wrote ${cookies.length} cookies across ${domains.size} domain(s) to ${outputPath}\n`
  );
  if (skipped.length > 0) {
    process.stdout.write(
      `Skipped ${skipped.length} malformed line(s) (first reason: ${skipped[0].reason})\n`
    );
  }
}

main();
