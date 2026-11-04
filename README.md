# YClash

A private-by-account Clash of Clans village tracker with upgrade and potion timers, event listings, account review, and optional Discord notifications.

## Requirements

- Node.js 20 LTS or newer
- npm

## Run locally

1. Copy `.env.example` to `.env`.
2. Set a unique `ADMIN_PASSWORD` (20-128 alphanumeric characters).
3. Optionally set `COC_API_TOKEN` for player review, or Discord bot configuration for notifications. Never commit `.env`.
4. Install and start:

   ```sh
   npm ci
   npm start
   ```

5. Open `http://localhost:3000`.

The app stores accounts and timer data in `data/`. Back up this directory privately. It is excluded from Git.

See [README-COC-TRACKER.md](README-COC-TRACKER.md) for feature notes, API setup, and deployment guidance.

## Security

Never commit `.env`, API or Discord tokens, SSH keys, production data, or backups. See [SECURITY.md](SECURITY.md) for reporting security issues.

## License

MIT. See [LICENSE](LICENSE).

YClash is an independent fan project and is not affiliated with, endorsed by, or sponsored by Supercell.