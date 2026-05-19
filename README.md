# GoPod

GoPod is a private, recommendation-free RSS podcast player. Add the podcast feeds you choose, browse episodes in reverse chronological order, and keep playback state in your browser without accounts, algorithmic discovery, or platform recommendations.

Production: https://podcast-app-livid.vercel.app/

## Features

- Add podcast RSS feed URLs directly.
- View all recent episodes together or filter by show.
- Play episodes with a persistent now-playing bar.
- Resume episodes from saved playback progress.
- Refresh individual feeds or all saved feeds.
- Export and import GoPod backup JSON files.
- Store saved feeds, recent episode cache, and playback state locally in browser storage.

## Architecture

- Next.js app router frontend.
- `GET /api/feed` server route for validating, fetching, and parsing public RSS feeds.
- Local browser storage for saved feeds, episode cache, and playback progress.
- No account system, social feed, recommendations, Trending surface, or third-party podcast directory integration.

## Local Development

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000/
```

## Checks

Run lint:

```bash
npm run lint
```

Run a production build:

```bash
npm run build
```

## Data Model

GoPod stores its app state in browser `localStorage`:

- saved podcast feeds
- recent parsed episode cache
- playback progress and played state

Use the built-in export/import controls to move that local state between browsers or keep a backup.
