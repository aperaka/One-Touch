# One Touch

One Touch is a multi-sport fantasy sports prototype with live scores, dynamic player pools, and user accounts.

## Run locally

1. Install Node.js 18+.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm start` (or `npm.cmd start` in Windows PowerShell if script execution is restricted).
5. Open `http://localhost:3000`.

Without `DATABASE_URL`, One Touch uses local JSON user storage so development stays simple.

## PostgreSQL setup

For persistent production accounts:

1. Create a PostgreSQL database with your hosting/database provider.
2. Set `DATABASE_URL` using the format shown in `.env.example`.
3. Run `npm run db:init` to create the One Touch tables.
4. Start the app with `npm start`.

When `DATABASE_URL` is present, signup/login accounts and sessions use PostgreSQL. Session tokens are stored as SHA-256 hashes in the database and browser cookies are HttpOnly, SameSite=Lax, and Secure when `NODE_ENV=production`.

The included schema also creates tables for fantasy teams, selected fantasy players, leagues, and league membership so those features can be persisted next.

## Account API

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/health`

## Included sports

- Soccer: Premier League, La Liga, Serie A, Bundesliga, Ligue 1
- Basketball: NBA
- Football: NFL
- Baseball: MLB
- Tennis: ATP and WTA

The backend proxies sports data for the frontend and caches player data for faster loading. Live score/player sources used by this prototype are unofficial and may change, so a licensed sports-data provider is recommended before a production launch.
