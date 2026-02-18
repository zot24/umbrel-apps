<!-- Source: https://github.com/getumbrel/umbrel-community-app-store -->

# Community App Stores

Guide to creating and using community app stores for distributing apps outside the official Umbrel App Store.

## Overview

Community App Stores allow independent distribution of Umbrel apps without going through the official submission process. Users add your store's GitHub URL and your apps appear in their App Store UI.

---

## Creating a Community App Store

### 1. Use the Template

Start from: https://github.com/getumbrel/umbrel-community-app-store

Click "Use this template" to create your own repository.

### 2. Configure umbrel-app-store.yml

```yaml
id: "mystore"     # Unique prefix — all app IDs must start with this
name: "My Store"  # Displays as "My Store Community App Store"
```

### 3. Structure Your Apps

App directories MUST be prefixed with your store ID:

```
my-community-store/
├── umbrel-app-store.yml
├── mystore-app-one/
│   ├── docker-compose.yml
│   ├── umbrel-app.yml
│   └── exports.sh
└── mystore-app-two/
    ├── docker-compose.yml
    ├── umbrel-app.yml
    └── exports.sh
```

**Critical**: The app `id` in `umbrel-app.yml` must also start with your store ID:
```yaml
id: mystore-app-one    # Matches directory name
```

---

## Icon & Gallery Handling (Important!)

**Icons DO NOT work from the app folder in community stores.**

Umbrel attempts to fetch icons from the official gallery repository, resulting in broken icons for community store apps. See: https://github.com/getumbrel/umbrel/issues/1998

### Workaround: External Gallery Repository

**Step 1**: Create a separate gallery repository (e.g., `username/umbrel-apps-gallery`):

```
umbrel-apps-gallery/
└── mystore-app-one/
    ├── icon.png      # 256x256 PNG (or SVG)
    ├── 1.jpg         # 1440x900 gallery image
    ├── 2.jpg
    └── 3.jpg
```

**Step 2**: Use full raw GitHub URLs in `umbrel-app.yml`:

```yaml
manifestVersion: 1
id: mystore-app-one
name: My App
icon: https://raw.githubusercontent.com/username/umbrel-apps-gallery/main/mystore-app-one/icon.png
category: automation
gallery:
  - https://raw.githubusercontent.com/username/umbrel-apps-gallery/main/mystore-app-one/1.jpg
  - https://raw.githubusercontent.com/username/umbrel-apps-gallery/main/mystore-app-one/2.jpg
  - https://raw.githubusercontent.com/username/umbrel-apps-gallery/main/mystore-app-one/3.jpg
# ... rest of manifest
```

**Key points:**
- Use full raw GitHub URLs for both `icon:` and `gallery:` fields
- PNG works fine (doesn't need to be SVG)
- The `icon:` field is NOT in the official template but IS required for community stores

---

## Adding a Community Store to Umbrel

### Via UI (Recommended)

1. Open Umbrel dashboard
2. Go to **App Store**
3. Click **Community App Stores**
4. Add your GitHub repository URL

### Via CLI

```bash
ssh umbrel@umbrel.local
sudo ~/umbrel/scripts/repo add https://github.com/username/my-community-store.git
sudo ~/umbrel/scripts/repo update
```

### Removing a Store

```bash
sudo ~/umbrel/scripts/repo remove https://github.com/username/my-community-store.git
```

---

## Example Community Stores

| Store | Repository | Focus |
|-------|------------|-------|
| Alby | https://github.com/getAlby/umbrel-community-app-store | Lightning apps |
| Denny's | https://github.com/dennysubke/dennys-umbrel-app-store | Various utilities |
| Sovereign Stack | https://github.com/sovereign-stack/community-apps | Self-hosting tools |

---

## Official vs Community Stores

| Feature | Official Store | Community Store |
|---------|---------------|-----------------|
| Review process | Full Umbrel team review | None (user responsibility) |
| Icon/gallery hosting | Automatic | Requires external gallery repo |
| App ID prefix | None required | Must use store ID prefix |
| Trust level | Vetted by Umbrel | User must verify |
| Automatic updates | Yes | When repo is updated |
| URL | https://apps.umbrel.com | Any GitHub repo |

---

## Trust & Safety

- Community apps are **NOT reviewed** by the Umbrel team
- Review the app's source code before installing
- Check the store maintainer's reputation
- Community apps have **full access** to your system
- Be cautious with apps that request sensitive data or mount host directories

---

## Best Practices for Store Maintainers

1. **Document your apps** — Include README with what each app does
2. **Pin image digests** — Use `@sha256:` for deterministic builds
3. **Use the gallery workaround** — External URLs for icons and screenshots
4. **Version your apps** — Update `version` and `releaseNotes` in manifests
5. **Test on multiple architectures** — ARM64 and x86_64
6. **Respond to issues** — Monitor your repository for user reports

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-community-app-store
- https://github.com/getumbrel/umbrel/issues/1998
