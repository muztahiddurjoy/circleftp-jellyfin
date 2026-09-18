# circleftp-jellyfin

A small, self-hosted web app that puts a proper browsing UI in front of
[Circle FTP](http://new.circleftp.net) and downloads what you pick straight into the folder your
Jellyfin server already watches.

Log in → search → press **Add to Jellyfin** → watch the progress bar. The files land in your
Nextcloud media folder, laid out the way Jellyfin expects, and both Nextcloud and Jellyfin are
told to rescan when the job finishes.

## Status

Under active development. See `docs/` for the implementation plan.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript, TanStack Query |
| Backend | Express 5 + TypeScript |
| Database | SQLite via Prisma |
| Downloads | In-process queue, resumable HTTP range downloads |
| Live progress | Server-Sent Events |

## Repository layout

```
packages/shared/   types + zod schemas shared by server and web
packages/server/   Express API, Prisma schema, download worker
packages/web/      React single-page app
deploy/            systemd unit, nginx vhost, root setup script
```

## Quick start

```bash
npm install
cp .env.example packages/server/.env   # then edit
npm run db:migrate
npm run user:create -- --email you@example.com --admin
npm run build
npm start
```

Development (API on :7070, Vite on :5173 proxying `/api`):

```bash
npm run dev
```

## License

MIT
