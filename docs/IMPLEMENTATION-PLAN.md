# circleftp-jellyfin — web app plan

## Context

Today the only way to pull media off Circle FTP into the Jellyfin library is the Hermes
`circleftp` plugin (`~/.hermes/plugins/circleftp/`), driven by WhatsApp messages. That works,
but it is conversational: no browsing, no posters, no visible queue, and it is tied to Hermes
running.

This replaces that interaction model with a proper web app: log in, browse/search Circle FTP
through the site (it acts as a proxy — the site never links out), press **Add to Jellyfin**, and
the server downloads the files into the Nextcloud folder Jellyfin already watches, showing live
progress. The Hermes plugin stays untouched; this is a separate, standalone product.

### Verified facts this plan is built on

| Fact | Value |
|---|---|
| Circle FTP API | `http://new.circleftp.net:5000/api` — `GET /posts?searchTerm=&order=desc`, `GET /posts/:id`. Verified live. |
| Poster images | `http://new.circleftp.net:5000/uploads/<image>` — verified 200 image/jpeg |
| Jellyfin | Docker (`/opt/jellyfin/docker-compose.yaml`), host network, **10.11.11**, API on `127.0.0.1:8096`, runs as uid 1000 |
| Jellyfin "Movies" library | bind-mounts `/var/nextcloud-data/ncadmin/files/Movies` → `/media:ro` |
| Destination dir | `/var/nextcloud-data/ncadmin/files/Movies` — `www-data:www-data 2775`, **writable by `muz-server`** (verified) |
| occ rescan | `/etc/sudoers.d/circleftp-occ` already grants `(www-data) NOPASSWD: php /var/www/nextcloud/occ files:scan *` — **reuse as-is, no new sudoers rule** |
| Node / npm | v24.19.0 / 11.17.0 |
| Free port | **7070** (7070 unused; 3000/8096/8123/2283 are taken) |
| `gh` CLI | authenticated as `muztahiddurjoy` |
| sudo | **requires a password** — root steps ship as a script for you to run |

### Decisions taken (from your answers)

- Repo: **`muztahiddurjoy/circleftp-jellyfin`**, public
- Auth: **seeded admin + invite codes**, no public signup
- Content: **movies *and* series** (series get Jellyfin `Season NN/Show SxxExx` layout)
- Exposure: **nginx vhost + Cloudflare tunnel**, alongside direct Tailscale `:7070`

---

## Architecture

TypeScript everywhere, npm workspaces monorepo:

```
circleftp-jellyfin/
├── packages/shared/    @cfj/shared — types + zod schemas used by BOTH server and web
├── packages/server/    Express 5 + Prisma/SQLite + download worker  (serves the built SPA)
├── packages/web/       React + Vite + TanStack Query
└── deploy/             systemd unit, nginx vhost, setup-root.sh
```

One process in production: Express serves the API *and* the built React bundle on `:7070`.
In dev, Vite runs on `:5173` and proxies `/api` to `:7070`.

### Why these choices

- **In-process download worker, not a separate daemon.** The Hermes plugin needed a separate
  systemd unit because the agent process is short-lived. This server is long-lived, so the queue
  lives in it — one unit, one log, and SSE progress needs no IPC. Crash recovery = on boot, reset
  `RUNNING` jobs to `QUEUED`.
- **Concurrency 1 by default.** The plugin's notes are explicit: Circle FTP hosts give ~9–10 MB/s
  single-stream and *parallel range splitting is slower*. Configurable via `DOWNLOAD_CONCURRENCY`.
- **Server-side image proxy.** Circle FTP posters are plain HTTP; the site will be HTTPS through
  Cloudflare, so hotlinking them = mixed content, blocked. `/api/library/image/:name` proxies and
  disk-caches them.
- **`bcryptjs`, not `argon2`.** Pure JS, no native build to break on Node 24 upgrades.
- **DB-backed sessions, not bare JWT.** A `Session` row makes logout and "revoke everywhere" real.
  httpOnly + SameSite=Lax cookie.

### Data model (Prisma, SQLite)

```prisma
User         id, email @unique, passwordHash, name, role(ADMIN|USER), createdAt
Session      id, userId, expiresAt, userAgent, createdAt
Invite       code @unique, role, createdById, usedById?, expiresAt
Download     id, userId, postId, title, folderName, kind(MOVIE|SERIES), posterImage,
             status(QUEUED|RUNNING|COMPLETED|PARTIAL|FAILED|CANCELLED),
             totalBytes, downloadedBytes, error, seasonsJson, timestamps
DownloadFile id, downloadId, order, url, relPath, label, season, episode,
             sizeBytes, downloadedBytes, status, attempts, error
```

### Logic ported from the Python plugin

`circleftp_core.py` is the reference implementation; these get ported to TS **with unit tests
pinning the same behaviour** (`packages/server/src/circleftp/`):

- `sanitize`, `firstYear`, `folderTitle` → `"Name (Year)"`
- `parseSeasonNumber`, `parseEpisodeNumber`, `filenameFromUrl`
- `search()` ranking: exact → prefix → contains → title → weak, with the "keep weak matches only
  if nothing better exists" rule (the API OR-matches every word, so multi-word queries are noisy)
- `buildPlan()`: `series` → `Season NN/<Show> SxxEyy - <file>`; `singleVideo`/`singleFile` →
  flat file; `multiVideo`/`multiFile` → parts; plus rel-path de-duplication
- `probeSizes()`: HEAD, falling back to a 1-byte `Range` GET on 403/405

---

## Implementation steps

Each step ends with a commit + push. Steps 1–24 need no root.

**Foundation**
1. Scaffold monorepo (workspaces, tsconfig base, eslint/prettier, .gitignore, MIT LICENSE, README stub). `gh repo create muztahiddurjoy/circleftp-jellyfin --public`, first push.
2. `@cfj/shared`: DTOs + zod schemas for auth, search results, title detail, download job/file, SSE events.
3. Server skeleton: Express 5, zod-validated env loader, helmet, pino logger, `/api/health`, `tsx` dev + `tsc` build.
4. Prisma: schema above, initial migration, client singleton, `db:migrate`/`db:studio` scripts.

**Auth**
5. Password hashing, session create/verify, cookie handling, `requireAuth` middleware, login rate-limit.
6. `POST /api/auth/login|logout`, `GET /api/auth/me`; CSRF via SameSite + required `X-Requested-With`.
7. Admin CLI: `npm run user:create` (seed admin), `user:passwd`, `invite:create`; `POST /api/auth/redeem` for invite signup.

**Circle FTP proxy**
8. API client (`undici`, timeouts, retry, UA) + response normalizers; `kindOf`, `mainCategory`.
9. Port `sanitize`/`folderTitle`/season+episode parsing + **unit tests**.
10. Port `search()` ranking + `enrichSeries()` (parallel detail fetch for season/episode counts) + **unit tests**.
11. Port `buildPlan()` for all five post types + de-duplication + **unit tests**.
12. Port `probeSizes()` with the Range-GET fallback.
13. Routes: `GET /api/library/search`, `GET /api/library/title/:id` (returns plan preview + sizes), `GET /api/library/image/:name` (proxy + disk cache), all behind auth.

**Downloads**
14. `POST /api/downloads` — build plan for chosen seasons, insert `Download` + `DownloadFile` rows, enqueue. Reject duplicates of an active job for the same post.
15. Worker: sequential queue, `.part` file + `Range` resume, retry with backoff (`MAX_ATTEMPTS`), throttled progress writes, free-space guard (`MIN_FREE_GIB`), crash recovery on boot.
16. `GET /api/downloads`, `GET /api/downloads/:id`, `POST /api/downloads/:id/cancel`, `/retry`, `DELETE /api/downloads/:id` (with optional file removal).
17. Post-processing on completion: `sudo -u www-data php /var/www/nextcloud/occ files:scan --path=...` (existing sudoers rule) + optional Jellyfin `POST /Library/Refresh` with `X-Emby-Token`. Both individually toggleable and non-fatal.
18. `GET /api/events` — SSE stream of job/file progress, per-user, with heartbeat.
19. Integration tests: supertest against a temp SQLite DB — auth flow, library routes with a mocked Circle FTP, job lifecycle with a mocked HTTP file server.

**Frontend**
20. Vite + React + TS scaffold, router, TanStack Query, dark theme + design tokens, app shell/nav.
21. Login page + auth context + protected routes + invite-redemption page.
22. Library page: search box, poster grid, movie/series filter, skeletons, empty + error states.
23. Title page: poster, metadata, file list with sizes; **Add to Jellyfin** button; season multi-select for series; total-size confirm dialog.
24. Downloads page: live SSE progress (job bar + per-file rows, speed + ETA), cancel/retry/delete, status filters. Then: production build wired into Express static serving, responsive polish, toasts.

**Deploy & verify** (25–26 need your sudo password)
25. `deploy/`: `.env.example`, systemd unit using the **`sg www-data -c 'exec …'`** wrapper (the stale-login-session-group gotcha from the Hermes build — a `--user` unit otherwise inherits a group set without gid 33 and cannot write the Movies dir), nginx vhost for `request.foliolab.app` on **:80 plain HTTP** with `cloudflare-realip.conf` included — matching the pattern in `/etc/nginx/snippets/` — and `setup-root.sh` that installs both. **Do not add the hostname to the existing `:80` redirect block** (that one 301s to HTTPS and would loop through the tunnel).
26. Full run-through: build, migrate, seed your admin user, start the service, and drive a real end-to-end download of a small title so you can watch progress land in Jellyfin. Report the URL + credentials.

**Your two manual bits** (I cannot do these):
- Run `sudo bash deploy/setup-root.sh` (needs your password).
- In the Cloudflare Zero Trust dashboard: add ingress `request.foliolab.app → http://localhost:7070` and make the DNS record **Proxied (orange cloud)** — ingress is dashboard-managed with no API token on this box. Verify with `dig +short request.foliolab.app @1.1.1.1` (anycast IPs = good, bare `cfargotunnel.com` CNAME = grey cloud, broken).

---

## Verification

- `npm test` — vitest unit + integration suites across server and web.
- `npm run build` — clean `tsc` + Vite build, no type errors.
- Live smoke, run for you at the end:
  1. `curl :7070/api/health`
  2. log in through the UI
  3. search a known title (e.g. `Inception` → post 98217, `singleVideo`)
  4. **Add to Jellyfin**, watch the progress bar move
  5. confirm the file appears at `/var/nextcloud-data/ncadmin/files/Movies/Inception (2010)/`
  6. confirm it shows in Jellyfin (`/media` inside the container) and in Nextcloud
- I will leave the app running on `http://muz-server.tail7c2a6.ts.net:7070` for you to test,
  and hand you the seeded admin credentials.

## Out of scope

- Touching or migrating the Hermes `circleftp` plugin — it keeps working independently.
- Cloudflare Access policies in front of the hostname (app has its own login; note that the other
  foliolab.app services still have none).
- Transcoding, subtitles, metadata scraping — Jellyfin already does all of that.
