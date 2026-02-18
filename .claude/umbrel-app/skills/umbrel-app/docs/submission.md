<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md -->

# PR Submission

Guide to submitting an app to the official Umbrel App Store.

## Submission Process

1. Fork [getumbrel/umbrel-apps](https://github.com/getumbrel/umbrel-apps) on GitHub
2. Clone your fork locally
3. Create a new branch for your app
4. Add your app directory with all required files
5. Commit and push to your fork
6. Open a pull request using the template below
7. Wait for review from the Umbrel team

```bash
git clone https://github.com/<YOUR-USERNAME>/umbrel-apps.git
cd umbrel-apps
git checkout -b add-my-app
mkdir my-app
# Add docker-compose.yml, umbrel-app.yml, exports.sh
git add .
git commit -m "Add My App"
git push origin add-my-app
# Open PR on GitHub
```

---

## Required Assets

### Icon
- **Format**: SVG
- **Size**: 256x256px
- **No rounded corners** — Umbrel applies dynamic rounding with CSS
- The Umbrel team will help finalize the icon before the app goes live

### Gallery Images
- **Format**: PNG
- **Size**: 1440x900px
- **Count**: 3-5 images
- Upload screenshots and the Umbrel team will help design gallery images

**Note**: For initial submission, you can set `gallery: []` and `releaseNotes: ""` in the manifest. The Umbrel team will help with these during review.

---

## PR Template

```markdown
# App Submission

### App name
<Name>

### 256x256 SVG icon
_(Upload an icon with no rounded corners as it will be dynamically rounded with CSS.)_
_We will help finalize this icon before the app goes live in the Umbrel App Store._

<!-- Upload icon here -->

### Gallery images
_(Upload 3 to 5 high-quality gallery images (1440x900px) of your app in PNG format,
or just upload 3 to 5 screenshots of your app and we'll help you design the gallery images.)_
_We will help finalize these images before the app goes live in the Umbrel App Store._

<!-- Upload screenshots here -->

### I have tested my app on:
- [ ] umbrelOS on a Raspberry Pi
- [ ] umbrelOS on an Umbrel Home
- [ ] umbrelOS on Linux VM
```

---

## What Happens During Review

After you submit your PR, the Umbrel team will:

1. **Review your `docker-compose.yml`**:
   - Remove port conflicts with other apps
   - Pin Docker images to SHA256 digests (if not already)
   - Assign unique IP addresses to containers

2. **Review your `umbrel-app.yml`**:
   - Check manifest completeness
   - Verify category and metadata

3. **Help with assets**:
   - Finalize the app icon
   - Design gallery images from your screenshots

4. **Test the app** on supported hardware

---

## Updating an Existing App

To push an update:

1. Build, tag, and push new Docker images to Docker Hub
2. Open a new PR on `getumbrel/umbrel-apps` with:
   - Updated `docker-compose.yml` with new image digest
   - Updated `version` in `umbrel-app.yml`
   - Updated `releaseNotes` in `umbrel-app.yml`

---

## Pre-Submission Checklist

- [ ] App directory name matches `id` in manifest
- [ ] `docker-compose.yml` includes `app_proxy` service
- [ ] All Docker images use SHA256 digests
- [ ] Images are multi-architecture (ARM64 + x86_64)
- [ ] `umbrel-app.yml` has all required fields
- [ ] `exports.sh` exists (even if empty)
- [ ] Icon is 256x256 SVG with no rounded corners
- [ ] 3-5 gallery images at 1440x900 PNG (or screenshots for team to design)
- [ ] Persistent data uses `${APP_DATA_DIR}`
- [ ] App doesn't run as root
- [ ] Tested on at least one platform
- [ ] No hardcoded secrets or IP addresses

---

## Getting Help

- **Issues**: https://github.com/getumbrel/umbrel-apps/issues
- **Community**: https://community.umbrel.com
- **Discord**: https://discord.gg/efNtFzqtdx

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
