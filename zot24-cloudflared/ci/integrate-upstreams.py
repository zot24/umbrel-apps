#!/usr/bin/env python3
"""Try to bring new Radiokot and Umbrel cloudflared commits into this app.

Watches three upstreams recorded in upstreams.json:

  ui         Radiokot/umbrel-cloudflared            -> zot24-cloudflared/web
  connector  Radiokot/umbrel-cloudflared-connector  -> zot24-cloudflared/connector
  umbrel     getumbrel/umbrel-apps cloudflared/     -> noted, not applied

The Umbrel app listing is not applied: our compose file, manifest, and
exports are rewritten for this store. The gallery repo is the other tree we
maintain; this script cannot open a PR there. A UI diff that touches
repository-assets/ says so in the report.

A cloudflared image tag or a manifest line that only says the daemon moved
is ignored. update-cloudflared.yml owns those, and the pin still advances
so the next run does not open a pull request for them.

Other files are applied. Files listed under "forked" in upstreams.json are
left untouched and copied into ci/pending/*-port.diff. The pull request is
where those get ported, keeping our digest, update-bin.sh, metrics port,
and the three-column route layout.

Does not commit. Prints changed=0 when there is nothing to review.
Prints pins=1 when a release-bump ignore advanced a SHA. A conflict keeps
the old SHA. The workflow leaves an open pull request for those same
target SHAs alone, so the retry happens after that pull request is closed.

Usage (from anywhere):
  python3 zot24-cloudflared/ci/integrate-upstreams.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "zot24-cloudflared"
STATE = APP / "ci" / "upstreams.json"
PENDING = APP / "ci" / "pending"
REPORT = PENDING / "REPORT.md"


def out(key: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(f"{key}={value}\n")


def fetch(url: str, accept: str) -> bytes:
    headers = {"Accept": accept, "User-Agent": "zot24-umbrel-apps"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:500]
        raise SystemExit(f"GitHub {error.code} for {url}: {detail}") from error


def latest_sha(source: dict) -> str:
    repo = source["repo"]
    if source.get("path"):
        url = (
            f"https://api.github.com/repos/{repo}/commits"
            f"?path={source['path']}&sha={source['branch']}&per_page=1"
        )
        commits = json.loads(fetch(url, "application/vnd.github+json"))
        if not commits:
            raise SystemExit(f"no commits for {repo} path {source['path']}")
        return commits[0]["sha"]
    url = f"https://api.github.com/repos/{repo}/commits/{source['branch']}"
    commit = json.loads(fetch(url, "application/vnd.github+json"))
    return commit["sha"]


def commit_subjects(repo: str, old: str, new: str) -> list[str]:
    url = f"https://api.github.com/repos/{repo}/compare/{old}...{new}"
    payload = json.loads(fetch(url, "application/vnd.github+json"))
    subjects = []
    for commit in payload.get("commits") or []:
        message = commit.get("commit", {}).get("message", "").splitlines()
        title = message[0] if message else commit.get("sha", "")[:7]
        subjects.append(f"{commit['sha'][:7]} {title}")
    return subjects


def compare_diff(repo: str, old: str, new: str) -> str:
    url = f"https://api.github.com/repos/{repo}/compare/{old}...{new}"
    text = fetch(url, "application/vnd.github.diff").decode("utf-8", errors="replace")
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        raise SystemExit(f"compare for {repo} {old[:7]}...{new[:7]} did not return a diff")
    return text


def split_diff(diff: str) -> list[tuple[str, str]]:
    """Return (path, section) pairs. path is the b/ side, without the b/ prefix."""
    if not diff.strip():
        return []
    parts = []
    current: list[str] = []
    path = ""
    for line in diff.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current:
                parts.append((path, "".join(current)))
            current = [line]
            # diff --git a/old b/new
            quoted = line.strip().split(" b/", 1)
            path = quoted[1] if len(quoted) == 2 else ""
        else:
            current.append(line)
    if current:
        parts.append((path, "".join(current)))
    return parts


def excluded(path: str, prefixes: list[str]) -> bool:
    return any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in prefixes)


def rewrite_section(section: str, dest: str) -> str:
    """Prefix a/ and b/ paths so git apply lands in dest/.

    Header lines only. A hunk line can look like `+++ b/...` when the added
    source line starts with `++ b/`.
    """
    rewritten = []
    in_hunk = False
    for line in section.splitlines(keepends=True):
        if line.startswith("@@"):
            in_hunk = True
        if not in_hunk:
            if line.startswith("diff --git "):
                line = line.replace(" a/", f" a/{dest}/", 1).replace(" b/", f" b/{dest}/", 1)
            elif line.startswith("--- a/"):
                line = "--- a/" + dest + "/" + line[len("--- a/") :]
            elif line.startswith("+++ b/"):
                line = "+++ b/" + dest + "/" + line[len("+++ b/") :]
            elif line.startswith("rename from "):
                line = "rename from " + dest + "/" + line[len("rename from ") :]
            elif line.startswith("rename to "):
                line = "rename to " + dest + "/" + line[len("rename to ") :]
        rewritten.append(line)
    return "".join(rewritten)


def unapplicable(section: str) -> bool:
    """GitHub emits this when it has no binary delta we can apply."""
    return "Binary files " in section and " differ" in section and "GIT binary patch" not in section


def changed_lines(section: str) -> list[str]:
    lines = []
    in_hunk = False
    for line in section.splitlines():
        if line.startswith("@@"):
            in_hunk = True
            continue
        if not in_hunk:
            continue
        if line.startswith(("+", "-")) and not line.startswith(("+++", "---")):
            lines.append(line[1:].strip())
    return lines


def line_is_release_bump(path: str, line: str) -> bool:
    """True when the line only moves a cloudflared image or says that it did.

    The hourly update-cloudflared job owns those lines. A line that also
    adds behavior (arguments, a protocol, a port, a token path) does not.
    """
    text = line.strip()
    if re.fullmatch(r"FROM\s+cloudflare/cloudflared:\S+(?:\s+as\s+\S+)?", text):
        return True
    if re.fullmatch(r"image:\s+\S+", text) and (
        "cloudflare/cloudflared:" in text or "ghcr.io/radiokot/umbrel-cloudflared" in text
    ):
        return True
    if path.rsplit("/", 1)[-1] != "umbrel-app.yml":
        return False
    if re.fullmatch(r'version:\s*"?\d{4}\.\d{1,2}\.\d{1,2}"?', text):
        return True
    if re.fullmatch(r"releaseNotes:\s*>-?", text):
        return True
    if not re.search(r"cloudflared", text, re.I):
        return False
    if not re.search(r"\d{4}\.\d{1,2}\.\d{1,2}", text):
        return False
    if re.search(r"\b(argument|protocol|http/2|quic|volume|port|token|route)\b", text, re.I):
        return False
    return True


def release_bump_only(path: str, section: str) -> bool:
    lines = changed_lines(section)
    return bool(lines) and all(line_is_release_bump(path, line) for line in lines)


def is_forked(source: dict, rel: str) -> bool:
    for item in source.get("forked") or []:
        if rel == item or rel.startswith(item.rstrip("/") + "/"):
            return True
    return False


def classify_diff(diff: str, source: dict) -> dict:
    """Split an upstream diff into release bumps, forked files, and the rest.

    Release bumps are dropped. Forked files are rewritten for our tree but
    not applied. The rest is what git apply sees when this source is applied.
    """
    only = source.get("path")
    exclude = source.get("exclude") or []
    dest = source.get("dest")
    apply_sections: list[str] = []
    forked_sections: list[str] = []
    result = {
        "apply": "",
        "apply_paths": [],
        "bumps": [],
        "forked": "",
        "forked_paths": [],
        "skipped": [],
    }
    for path, section in split_diff(diff):
        if only and not (path == only or path.startswith(only + "/")):
            continue
        rel = path[len(only) + 1 :] if only else path
        if excluded(rel, exclude) or unapplicable(section):
            result["skipped"].append(path)
            continue
        if release_bump_only(rel, section):
            result["bumps"].append(path)
            continue
        rewritten = rewrite_section(section, dest) if dest and source.get("apply", True) else section
        if source.get("apply", True) and is_forked(source, rel):
            forked_sections.append(rewritten)
            result["forked_paths"].append(path)
            continue
        apply_sections.append(rewritten)
        result["apply_paths"].append(path)
    result["apply"] = "".join(apply_sections)
    result["forked"] = "".join(forked_sections)
    return result


def apply_diff(diff: str) -> tuple[bool, str]:
    if not diff.strip():
        return True, ""
    process = subprocess.run(
        ["git", "apply", "--whitespace=nowarn", "--reject", "--unsafe-paths", "-"],
        input=diff.encode(),
        cwd=ROOT,
        capture_output=True,
    )
    error = process.stderr.decode("utf-8", errors="replace").strip()
    return process.returncode == 0, error


def reject_files() -> list[str]:
    return sorted(str(path.relative_to(ROOT)) for path in APP.rglob("*.rej") if path.is_file())


def clear_rejects() -> None:
    for path in APP.rglob("*.rej"):
        if path.is_file():
            path.unlink()


def write_report(blocks: list[str], targets: dict[str, str]) -> None:
    PENDING.mkdir(parents=True, exist_ok=True)
    target_line = " ".join(f"{name}={sha}" for name, sha in targets.items())
    body = [
        f"targets: {target_line}",
        "",
        "Upstream product changes for this app. Cloudflared image tags are",
        "not in this pull request; the hourly update-cloudflared job commits those.",
        "Merge this if the applied edits look right. Port any forked files",
        "below before merging, and keep our digest, update-bin.sh, metrics",
        "port, and the three-column route layout. A source whose SHA did not",
        "move in `ci/upstreams.json` did not apply cleanly. The next run tries",
        "it again after this pull request is closed.",
        "",
        "Repos we maintain:",
        "- this one, zot24/umbrel-apps",
        "- zot24/umbrel-apps-gallery (icons and screenshots; this job cannot open a PR there)",
        "",
        "Upstreams:",
    ]
    body.extend(blocks)
    REPORT.write_text("\n".join(body).rstrip() + "\n", encoding="utf-8")


def main() -> int:
    state = json.loads(STATE.read_text(encoding="utf-8"))
    targets: dict[str, str] = {}
    moved = False
    for name, source in state.items():
        targets[name] = latest_sha(source)
        if targets[name] != source["sha"]:
            moved = True
    target_line = " ".join(f"{name}={sha}" for name, sha in targets.items())
    out("targets", target_line)
    if not moved:
        print("Upstreams match the pins.")
        out("changed", "0")
        out("pins", "0")
        return 0

    original = {name: source["sha"] for name, source in state.items()}
    # Drop a previous attempt's notes. A stale .rej would make a later
    # clean apply look failed, because reject_files() scans the app tree.
    if PENDING.exists():
        for path in PENDING.iterdir():
            if path.is_file():
                path.unlink()
    clear_rejects()

    blocks: list[str] = []
    assets_changed = False
    needs_pr = False
    for name, source in state.items():
        new = targets[name]
        old = source["sha"]
        if new == old:
            blocks.append(f"\n## {name}\n\nUnchanged `{source['repo']}` `{old[:7]}`.\n")
            continue
        print(f"{name}: {old[:7]} -> {new[:7]}")
        diff = compare_diff(source["repo"], old, new)
        classified = classify_diff(diff, source)
        subjects = commit_subjects(source["repo"], old, new)
        if any(path == "repository-assets" or path.startswith("repository-assets/") for path in classified["skipped"]):
            assets_changed = True
        lines = [
            f"\n## {name}",
            "",
            f"`{source['repo']}` `{old[:7]}` -> `{new[:7]}`",
            "",
        ]
        if subjects:
            lines.append("Commits:")
            lines.extend(f"- {subject}" for subject in subjects[:30])
            lines.append("")
        if classified["bumps"]:
            lines.append("Ignored cloudflared release bumps. The hourly job owns those:")
            lines.extend(f"- `{path}`" for path in classified["bumps"])
            lines.append("")
        if not source.get("apply", True):
            if classified["apply"].strip():
                PENDING.mkdir(parents=True, exist_ok=True)
                (PENDING / f"{name}.diff").write_text(classified["apply"], encoding="utf-8")
                needs_pr = True
                lines.append(
                    f"Product changes are in `ci/pending/{name}.diff`. "
                    "Our compose and manifest stay as written for this store. "
                    "Image tag lines in that diff are still the hourly job."
                )
            else:
                lines.append("Nothing to port. The commits only move the cloudflared release.")
            source["sha"] = new
            lines.append("")
            blocks.append("\n".join(lines))
            continue
        if classified["forked_paths"]:
            PENDING.mkdir(parents=True, exist_ok=True)
            (PENDING / f"{name}-port.diff").write_text(classified["forked"], encoding="utf-8")
            needs_pr = True
            lines.append(
                f"Forked files were left untouched. Port `ci/pending/{name}-port.diff` "
                "before merging. Keep our cloudflared digest, update-bin.sh, the metrics "
                "port, and the three-column route layout. Drop image-tag edits in that diff."
            )
            lines.append("")
            lines.append("Forked files:")
            lines.extend(f"- `{path}`" for path in classified["forked_paths"])
            lines.append("")
        before = set(reject_files())
        ok, error = apply_diff(classified["apply"])
        rejects = [path for path in reject_files() if path not in before]
        if ok and not rejects:
            source["sha"] = new
            if classified["apply_paths"]:
                needs_pr = True
                lines.append("Applied cleanly:")
                lines.extend(f"- `{path}`" for path in classified["apply_paths"])
            else:
                lines.append("No product changes under the paths we vendor.")
        else:
            needs_pr = True
            lines.append("Did not apply cleanly, so the pin was left where it is.")
            if error:
                lines.append("")
                lines.append("```")
                lines.append(error[:4000])
                lines.append("```")
            if rejects:
                lines.append("")
                lines.append("Reject files:")
                lines.extend(f"- `{path}`" for path in rejects)
        if classified["skipped"]:
            lines.append("")
            lines.append("Left for a person:")
            lines.extend(f"- `{path}`" for path in classified["skipped"])
        lines.append("")
        blocks.append("\n".join(lines))

    if assets_changed:
        needs_pr = True
        blocks.append(
            "\n## Gallery\n\n"
            "Upstream screenshot or icon files changed. Those live in "
            "zot24/umbrel-apps-gallery, which this workflow does not push to.\n"
        )
    pins_moved = any(state[name]["sha"] != original[name] for name in state)
    if needs_pr or pins_moved:
        STATE.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    if needs_pr:
        write_report(blocks, targets)
        print(f"Integration ready. targets: {target_line}")
        out("changed", "1")
    else:
        print("No product changes. Release bumps are ignored.")
        out("changed", "0")
    out("pins", "1" if pins_moved else "0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
