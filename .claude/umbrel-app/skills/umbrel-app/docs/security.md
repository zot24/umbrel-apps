<!-- Source: https://github.com/getumbrel/umbrel-apps/blob/master/README.md -->

# App Security & Authentication

Guide to authentication, access control, and security for Umbrel apps.

## Built-in App Proxy Authentication

Umbrel's `app_proxy` service automatically protects every app with:
- Umbrel password authentication
- Optional 2FA support
- Session token validation on every HTTP/WebSocket request

**Default behavior**: All apps require Umbrel login. No configuration needed.

---

## Configuring App Proxy Authentication

### Disable Auth (Public Access)

For apps that handle their own authentication or need public access:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 8080
      PROXY_AUTH_ADD: "false"    # Disables Umbrel auth entirely
```

### Path-Based Authentication

#### Protect Everything Except API

Public root, but app's API uses its own token auth:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 8080
      PROXY_AUTH_WHITELIST: "/api/*"   # /api/* bypasses Umbrel auth
```

#### Protect Only Admin Section

Public app, but admin area requires Umbrel login:

```yaml
services:
  app_proxy:
    environment:
      APP_HOST: my-app_web_1
      APP_PORT: 8080
      PROXY_AUTH_WHITELIST: "*"          # Everything public
      PROXY_AUTH_BLACKLIST: "/admin/*"   # Except /admin
```

### Summary Table

| Scenario | Configuration |
|----------|---------------|
| Protect entire app (default) | No config needed |
| Disable auth completely | `PROXY_AUTH_ADD: "false"` |
| Public root, protected admin | `PROXY_AUTH_WHITELIST: "*"` + `PROXY_AUTH_BLACKLIST: "/admin/*"` |
| Protected root, public API | `PROXY_AUTH_WHITELIST: "/api/*"` |

---

## Verifying Auth Configuration

```bash
# SSH into Umbrel
ssh umbrel@umbrel.local

# Check app's docker-compose for auth settings
cat ~/umbrel/app-stores/*/<app-id>/docker-compose.yml | grep -A5 "app_proxy"

# Look for: PROXY_AUTH_ADD: "false"
# If present, auth is DISABLED for this app
```

---

## Additional Security Layers

### Nginx Proxy Manager

For apps needing additional protection:

1. Install **Nginx Proxy Manager** from the Umbrel App Store
2. Features:
   - Access Lists (restrict by IP/subnet)
   - Basic HTTP Authentication (additional password layer)
   - Free SSL certificates via Let's Encrypt
   - Custom proxy headers

### Zoraxy Reverse Proxy

For IP-based access control:

1. Install **Zoraxy** from the Umbrel App Store
2. Features:
   - Geo-IP based blocking/allowing
   - IP blacklisting/whitelisting
   - Rate limiting
   - DDoS protection

### External SSO Solutions

For advanced enterprise-like authentication across multiple apps:

| Solution | Use Case | Complexity | Resources |
|----------|----------|------------|-----------|
| Authelia | Lightweight MFA portal | Medium | < 30MB RAM |
| Authentik | Full identity provider (SAML/OIDC) | High | Needs DB + Redis |

**Note**: These are NOT in the Umbrel App Store and require manual Docker deployment alongside Umbrel.

---

## Tor Access

Apps can be accessed via Tor hidden services for privacy:

- `$APP_HIDDEN_SERVICE` provides the `.onion` address
- Set `torOnly: true` in manifest if the app should only be accessible via Tor
- Tor proxy available at `$TOR_PROXY_IP:$TOR_PROXY_PORT`

---

## Security Best Practices for App Developers

### Docker Security

- [ ] Don't run as root — use `USER 1000` in Dockerfile
- [ ] Mount sensitive directories read-only (`:ro`)
- [ ] Don't use `--privileged` or `network_mode: host`
- [ ] Pin images to SHA256 digests for supply chain security
- [ ] Minimize container capabilities

### Data Security

- [ ] Store persistent data only in `${APP_DATA_DIR}`
- [ ] Don't hardcode secrets — use `$APP_PASSWORD` or `$APP_SEED`
- [ ] Don't log sensitive data (passwords, keys, tokens)
- [ ] Encrypt sensitive data at rest when possible

### Network Security

- [ ] Don't expose unnecessary ports
- [ ] Use the `app_proxy` for HTTP traffic (handles auth automatically)
- [ ] For non-HTTP services, document the exposed port clearly
- [ ] Use HTTPS for external API calls

### Access Control

- [ ] Keep `app_proxy` auth enabled unless the app has its own auth
- [ ] Use path-based auth (`WHITELIST`/`BLACKLIST`) for mixed scenarios
- [ ] Enable Umbrel's 2FA for additional protection
- [ ] Document any default credentials in the manifest

---

## Security Checklist

- [ ] `app_proxy` service is present in `docker-compose.yml`
- [ ] `PROXY_AUTH_ADD` is not set to `"false"` (unless intentional)
- [ ] No hardcoded secrets or passwords
- [ ] Sensitive volumes mounted read-only
- [ ] App doesn't run as root
- [ ] 2FA enabled in Umbrel settings for extra protection
- [ ] For internet-exposed apps, consider additional access control layers
- [ ] Never expose sensitive apps without authentication

---

## Upstream Sources

- https://github.com/getumbrel/umbrel-apps/blob/master/README.md
