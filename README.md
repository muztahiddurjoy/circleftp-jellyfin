# circleftp-jellyfin

A self-hosted web app that puts a proper browsing UI in front of
[Circle FTP](http://new.circleftp.net) and downloads what you pick straight into the folder your
Jellyfin server already watches.

Sign in → search → **Add to Jellyfin** → watch the progress bar. Files land in your Nextcloud
media folder laid out the way Jellyfin expects, and both Nextcloud and Jellyfin are told to
rescan when the job finishes.

```
┌──────────┐   search    ┌────────────────┐   HTTP+Range   ┌─────────────┐
│  Browser │ ──────────► │ circleftp-     │ ─────────────► │ Circle FTP  │
│  (React) │ ◄────────── │ jellyfin       │                │ ftpN hosts  │
└──────────┘    SSE      │ (Express+SQLite)│                └─────────────┘
                         └────────┬────────┘
                                  │ writes
                                  ▼
                    /var/nextcloud-data/…/Movies
                       ├── Inception (2010)/
                       └── Show (2021)/Season 01/Show S01E01 - ….mkv
                                  │
                       bind-mounted read-only into Jellyfin
```

## Features

- **Circle FTP proxy.** Search, posters and metadata all come through the app; the browser never
  talks to Circle FTP directly, so there is no mixed-content problem behind HTTPS.
- **Movies and series.** Series get Jellyfin's `Season NN/Show SxxEyy - …` layout, with per-season
  selection before you queue anything.
- **Resumable downloads.** Files are written as `.part` and renamed on completion, so Jellyfin
  never indexes a half-file. An interrupted transfer resumes with a Range request — including
  across an app restart.
- **Live progress.** Server-Sent Events push speed, ETA and per-file status with no polling.
- **Automatic reindexing.** `occ files:scan` for Nextcloud and `/Library/Refresh` for Jellyfin,
  both optional and both best-effort.
- **Invite-only.** No public sign-up. The first account is created from the CLI.
- **User management in the browser.** Add or remove accounts, promote and demote, disable, revoke
  sessions, and issue password reset links — see below.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + Vite + TypeScript, TanStack Query |
| Backend | Express 5 + TypeScript |
| Database | SQLite via Prisma |
| Downloads | In-process queue, resumable HTTP Range transfers |
| Live updates | Server-Sent Events |

In production one Node process serves both the API and the built React bundle.

## Repository layout

```
packages/shared/   types + zod schemas shared by server and web
packages/server/   Express API, Prisma schema, download worker, admin CLI
packages/web/      React single-page app
deploy/            systemd unit, nginx vhost, root setup script
scripts/           live smoke tests against a running instance
```

## Getting started

Requires Node 20+.

```bash
git clone https://github.com/muztahiddurjoy/circleftp-jellyfin.git
cd circleftp-jellyfin
npm install

cp packages/server/.env.example packages/server/.env
# Set SESSION_SECRET and MEDIA_ROOT:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run db:migrate
npm run build
npm run user:create -- --email you@example.com --name "You" --admin
npm start
```

The app is then on <http://localhost:7070>. `user:create` prints a generated password once —
save it.

### Development

```bash
npm run dev     # API on :7070, Vite on :5173 proxying /api
npm test        # unit + integration tests
npm run typecheck
```

## Configuration

Everything lives in `packages/server/.env` — see
[`.env.example`](packages/server/.env.example) for the annotated list. The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `7070` | |
| `SESSION_SECRET` | — | **Required in production.** Signs session cookies. |
| `COOKIE_SECURE` | `false` | Set `true` only if *every* route to the app is HTTPS. Plain HTTP over Tailscale means this must stay false, or logins silently fail there. |
| `MEDIA_ROOT` | `/var/nextcloud-data/ncadmin/files/Movies` | The folder Jellyfin watches. |
| `DOWNLOAD_CONCURRENCY` | `1` | Circle FTP hosts give ~9–10 MB/s single-stream and get *slower* when split across parallel ranges. Raise only if yours behave differently. |
| `MIN_FREE_GIB` | `5` | Refuses to start a file that would take the disk below this. |
| `NEXTCLOUD_SCAN_ENABLED` | `true` | Needs the sudoers rule below. |
| `JELLYFIN_REFRESH_ENABLED` | `false` | Needs `JELLYFIN_API_KEY` from Jellyfin → Dashboard → API Keys. |

### Nextcloud reindexing

The app shells out to `occ files:scan` as the web user. Grant it with
`/etc/sudoers.d/circleftp-jellyfin` (note the escaped colon):

```
youruser ALL=(www-data) NOPASSWD: /usr/bin/php /var/www/nextcloud/occ files\:scan *
```

Without it downloads still land on disk — only the Nextcloud index goes stale.

## Deployment

```bash
npm run build
sudo bash deploy/setup-root.sh
```

That installs and starts the systemd unit, and optionally an nginx vhost. Set `PUBLIC_HOST` to
change the hostname, or `INSTALL_NGINX=no` to skip nginx.

Two notes learned the hard way on the reference host:

- The unit runs Node through `sg www-data` rather than using `SupplementaryGroups=`. The media
  directory is www-data-owned; if the user's membership of that group was granted *after* the
  login session began, a service can inherit a group set without it and be unable to write.
- Behind a Cloudflare Tunnel, keep the ingress rule on plain HTTP (`http://localhost:7070`) and
  let nginx serve the hostname without TLS. The DNS record must be **proxied** (orange cloud) —
  a grey-clouded `CNAME → <id>.cfargotunnel.com` has no public IP and just fails to connect.

## Accounts and user management

### Your own account — `/account`

Change your display name, change your password, and see every device signed in as you with a
"sign out other devices" button. Changing your password signs out every other session and keeps
the one you changed it from.

### Administration — `/admin`

Visible only to administrators.

**Users.** Add an account (a strong password is generated and shown once), promote or demote,
disable or re-enable, sign an account out everywhere, issue a password reset link, or delete.
Deleting keeps the account's download history, detached from the account.

**Invites.** Create a code with a role, an expiry and a private note, share the link, and revoke
unused ones. A redeemed invite is kept as the record of how that account came to exist, so it
cannot be revoked away.

### Password resets

There is no mail server on the reference host, so there is no self-service "forgot password" by
email. Instead an administrator presses **Reset password** on a user's row and gets a one-time
link to pass on. The user opens it, chooses their own password, and is signed straight in — so
**the administrator never learns the password**. Links are single-use, expire (24 hours by
default), are invalidated if a newer one is issued, and sign every device out when redeemed.

A user who can still sign in should just use `/account` instead.

### Lock-out protection

There is no email recovery and no rescue console here, so the API refuses anything that would
leave nobody able to administer the app:

- the last *active* administrator cannot be demoted, disabled or deleted — and a **disabled**
  administrator does not count as cover, since it cannot sign in;
- you cannot disable or delete your own account.

The UI greys these actions out with an explanation rather than waiting for the server to say no.

## Admin CLI

```bash
npm run user:create  -- --email you@example.com --name "You" --admin
npm run user:passwd  -- --email you@example.com
npm run user:list
npm run invite:create -- --days 14           # prints a code; redeem it at /invite
```

Omitting `--password` generates a strong one and prints it once. The CLI is the way to create the
*first* account; after that, `/admin` does the same things in the browser.

## How it works

The Circle FTP API is undocumented; the client here was reverse-engineered from the site's own
React bundle and is a TypeScript port of the logic in a predecessor project, with unit tests
pinning the behaviour — these functions decide real paths on disk that Jellyfin has to recognise.

- `GET /posts?searchTerm=&order=desc` and `GET /posts/:id`. A post's `type` drives everything:
  `series` carries seasons and episodes, `singleVideo`/`singleFile` a bare URL, and
  `multiVideo`/`multiFile` a list of parts.
- The API OR-matches every word in a query, so "the batman" returns everything containing "the".
  Results are ranked exact → prefix → contains → title → weak, and weak matches are discarded
  whenever anything better exists.
- A request for a post that does not exist answers `200 OK` with an **empty body**, not a 404.
- File hosts are plain Apache and honour Range, which is what makes resume work.

## Security

- Invite-only; no public registration route.
- Passwords are bcrypt (cost 12). Unknown emails still burn a comparison, so response timing does
  not disclose which addresses have accounts.
- Sessions are random 32-byte tokens in an httpOnly cookie; only a SHA-256 is stored, so a stolen
  database yields no usable cookies.
- CSRF: SameSite=Lax *and* a required custom header. No CORS middleware is installed, so a
  cross-origin request cannot pass the preflight.
- Every download path is derived from untrusted upstream data, so `..` segments are dropped and
  the resolved path is proved to be inside `MEDIA_ROOT` before anything is written.
- Reset tokens are stored as SHA-256 like sessions, are single-use, and redemption runs in a
  transaction with a conditional claim so two requests on one link cannot both succeed.
- Changing a password or redeeming a reset revokes every other session for that account, and
  disabling an account revokes its sessions immediately rather than waiting for them to expire.

## Licence

MIT
