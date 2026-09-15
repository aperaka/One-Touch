# One Touch Live

A local prototype for One Touch with live score feeds and dynamic fantasy player pools.

## Run locally

1. Install Node.js 18+.
2. Open a terminal in this folder.
3. Run `npm start` (or `npm.cmd start` in Windows PowerShell if script execution is restricted).
4. Open `http://localhost:3000`.

## Included sports

- Soccer: Premier League, La Liga, Serie A, Bundesliga, Ligue 1
- Basketball: NBA
- Football: NFL
- Baseball: MLB
- Tennis: ATP and WTA

The backend proxies sports data for the frontend and caches player data for faster loading. Live score/player sources used by this prototype are unofficial and may change, so a licensed sports-data provider is recommended before a production launch.
