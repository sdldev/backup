# OAuth App Setup for Google and GitHub

Use this guide to create OAuth credentials for local development, staging, and production.

## Required environment variables

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
OAUTH_REDIRECT_BASE_URL=http://localhost:3000
WEB_BASE_URL=http://localhost:4321
```

`OAUTH_REDIRECT_BASE_URL` is the public base URL for the API app. OAuth providers redirect back to this host.

## Redirect URLs used by the app

Configure these exact callback URLs in provider dashboards:

```text
Google:  {OAUTH_REDIRECT_BASE_URL}/v1/auth/google/callback
GitHub:  {OAUTH_REDIRECT_BASE_URL}/v1/auth/github/callback
```

Examples:

```text
Local Google callback:  http://localhost:3000/v1/auth/google/callback
Local GitHub callback:  http://localhost:3000/v1/auth/github/callback
Prod Google callback:   https://api.example.com/v1/auth/google/callback
Prod GitHub callback:   https://api.example.com/v1/auth/github/callback
```

## Google OAuth credentials

1. Open Google Cloud Console:
   - https://console.cloud.google.com/
2. Select or create a project.
3. Configure consent screen:
   - Go to **APIs & Services → OAuth consent screen**.
   - Choose **External** unless using a Google Workspace internal app.
   - App name: your product/app name.
   - User support email: operations/support email.
   - Developer contact email: operations/security email.
   - Add scopes:
     - `openid`
     - `email`
     - `profile`
   - Add test users if app is still in testing mode.
4. Create OAuth client:
   - Go to **APIs & Services → Credentials**.
   - Click **Create Credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Name: `backup-saas-local` / `backup-saas-staging` / `backup-saas-production`.
5. Add Authorized redirect URIs:
   - Local: `http://localhost:3000/v1/auth/google/callback`
   - Staging/prod: `https://<api-domain>/v1/auth/google/callback`
6. Save.
7. Copy values into environment:

```env
GOOGLE_CLIENT_ID=<Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth client secret>
```

## GitHub OAuth credentials

1. Open GitHub Developer Settings:
   - https://github.com/settings/developers
2. Choose **OAuth Apps → New OAuth App**.
3. Fill app fields:
   - Application name: your product/app name.
   - Homepage URL:
     - Local: `http://localhost:4321`
     - Staging/prod: `https://<web-domain>`
   - Authorization callback URL:
     - Local: `http://localhost:3000/v1/auth/github/callback`
     - Staging/prod: `https://<api-domain>/v1/auth/github/callback`
4. Register application.
5. Generate client secret.
6. Copy values into environment:

```env
GITHUB_CLIENT_ID=<GitHub OAuth client ID>
GITHUB_CLIENT_SECRET=<GitHub OAuth client secret>
```

## Local development values

For Docker dev using current compose defaults:

```env
OAUTH_REDIRECT_BASE_URL=http://localhost:3000
WEB_BASE_URL=http://localhost:4321
GOOGLE_CLIENT_ID=<from Google>
GOOGLE_CLIENT_SECRET=<from Google>
GITHUB_CLIENT_ID=<from GitHub>
GITHUB_CLIENT_SECRET=<from GitHub>
SESSION_COOKIE_SECURE=false
```

Restart app after editing `.env`:

```bash
docker compose restart app web
```

## Production requirements

Use HTTPS in production:

```env
OAUTH_REDIRECT_BASE_URL=https://api.example.com
WEB_BASE_URL=https://app.example.com
SESSION_COOKIE_SECURE=true
```

Security rules:

- Keep client secrets out of git.
- Store production secrets in deployment secret manager.
- Use separate OAuth apps for local, staging, and production.
- Restrict Google OAuth test users until consent screen is verified.
- Rotate client secrets if exposed.
- Do not log OAuth access tokens, ID tokens, authorization codes, or client secrets.

## Troubleshooting

### `redirect_uri_mismatch`

Provider callback URL does not exactly match app callback URL.

Check:

- scheme: `http` vs `https`
- host: `localhost`, API domain, or proxy domain
- port: `3000`
- path: `/v1/auth/<provider>/callback`
- trailing slash: do not add one unless app sends one

### Browser returns to API instead of web app

Check `WEB_BASE_URL`. It should point to web host, for example:

```env
WEB_BASE_URL=http://localhost:4321
```

### Cookie not set during local dev

Use:

```env
SESSION_COOKIE_SECURE=false
```

For production HTTPS, use:

```env
SESSION_COOKIE_SECURE=true
```

### GitHub email missing or unverified

GitHub users may hide email. OAuth implementation should request verified primary email through GitHub email API. If no verified email exists, reject login with `AUTH_EMAIL_NOT_VERIFIED`.

### Google app stuck in testing

Add user email under OAuth consent screen test users, or publish/verify app for production use.
