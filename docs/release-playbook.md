# Research Agent Release Playbook

This playbook documents the exact release workflow used on **February 19, 2026** for the `v0.1.0-0219` reissue.

## 1. Scope of a release

Each release should publish these artifacts:

1. `install.sh` (installer entrypoint)
2. `research-agent-cli-<version>.tgz` (npm packed CLI)
3. `research-agent-backend-linux-amd64` (backend binary)
4. `research-agent-frontend-static.tar.gz` (frontend static bundle)

## 2. Preconditions

1. Ensure `gh` is authenticated:
```bash
gh auth status
```
2. Ensure working tree is clean (or stash unrelated changes):
```bash
git status --short
```
3. Export release identity:
```bash
OWNER=hao-ai-lab
REPO=research-agent
TAG=v0.1.0-0219
```

If branch/tag switch fails with `local changes would be overwritten`, either commit or stash first:
```bash
git stash push -u -m "wip-before-release-switch"
# ... switch branch/tag ...
git stash pop
```

## 3. Create release branch from tag

```bash
git fetch origin --tags
git switch -c "release/${TAG}-reissue" "$TAG"
```

Apply and commit release fixes (example: macOS tmux bootstrap fix):
```bash
git add scripts/research-agent install.sh
git commit -m "fix(installer): robust tmux bootstrap on macOS"
```

## 4. Build artifacts

### 4.1 CLI package

```bash
rm -f research-agent-cli-*.tgz
npm pack
CLI_TGZ="$(ls -t research-agent-cli-*.tgz | head -n1)"
echo "$CLI_TGZ"
```

### 4.2 Frontend static bundle

```bash
bash scripts/build-frontend-static.sh
```

Expected output artifact:

- `dist/research-agent-frontend-static.tar.gz`

### 4.3 Backend binary

```bash
bash server/build-backend-binary.sh
cp -f server/dist/research-agent-backend dist/research-agent-backend-linux-amd64
```

Expected output artifacts:

- `server/dist/research-agent-backend`
- `dist/research-agent-backend-linux-amd64`

## 5. Verify artifacts

### 5.1 Verify tmux fix is included in packaged CLI

```bash
tar -xOf "$CLI_TGZ" package/scripts/research-agent | grep -nE "TMUX_PANE|sleep 3600"
```

### 5.2 Compute checksums

```bash
sha256sum dist/research-agent-frontend-static.tar.gz
sha256sum dist/research-agent-backend-linux-amd64
```

Reference checksums from the February 19, 2026 run:

- frontend static: `49e48e5ff1e5cc07cb6271bed9d7af33d6b73fde32dfd45a7c1493d797ad8f5f`
- backend linux amd64: `0552d8914be1a29a4e6b837ecab190de349ec523ba259e6a40806638a823d37c`

## 6. Push branch and (optionally) reuse the same tag

Push branch:
```bash
git push -u origin "release/${TAG}-reissue"
```

If reusing the same tag name (what we did for `v0.1.0-0219`):
```bash
git tag -fa "$TAG" -m "$TAG reissued with installer/runtime fixes"
git push origin "refs/tags/$TAG" --force
```

## 7. Publish or update GitHub release assets

```bash
if gh release view "$TAG" --repo "$OWNER/$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" \
    install.sh \
    "$CLI_TGZ" \
    dist/research-agent-backend-linux-amd64 \
    dist/research-agent-frontend-static.tar.gz \
    --clobber \
    --repo "$OWNER/$REPO"
  gh release edit "$TAG" \
    --repo "$OWNER/$REPO" \
    --notes "Reissued: installer/runtime fixes and refreshed artifacts."
else
  gh release create "$TAG" \
    install.sh \
    "$CLI_TGZ" \
    dist/research-agent-backend-linux-amd64 \
    dist/research-agent-frontend-static.tar.gz \
    --repo "$OWNER/$REPO" \
    --title "$TAG" \
    --notes "Release artifacts for $TAG."
fi
```

Important shell note: do not leave a trailing `\` before `fi`, or your shell will stay at the `>` continuation prompt.

## 8. Installer smoke test

```bash
curl -fsSL "https://raw.githubusercontent.com/${OWNER}/${REPO}/${TAG}/install.sh" | bash
```

On macOS, verify tmux bootstrap behavior:

```bash
uid=$(id -u)
mkdir -p /private/tmp/tmux-$uid && chmod 700 /private/tmp/tmux-$uid
env -u TMUX -u TMUX_PANE tmux new-session -d -s ra-smoke 'sleep 2'
env -u TMUX -u TMUX_PANE tmux kill-session -t ra-smoke
```

Then start:
```bash
env -u TMUX -u TMUX_PANE research-agent start --project-root "$PWD"
```

## 9. Troubleshooting checklist

1. `Project root does not exist`
   - Check `--project-root` path is correct.
2. `no server running on /private/tmp/tmux-<uid>/default`
   - Confirm installed script includes:
     - `env -u TMUX -u TMUX_PANE tmux`
     - bootstrap loop `while :; do sleep 3600; done`
3. `git switch` blocked by local changes
   - Commit or stash first.
4. Missing `rg` in environment
   - Use `grep`/`sed` equivalents in release commands.

## 10. Recommended future strategy

Reissuing the same tag works, but a patch tag is safer for traceability:

- Preferred: `v0.1.0-0219.1`
- Reuse existing tag only when strictly required for installer compatibility.
