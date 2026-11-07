# Self-hosted sharing

Optional advanced setup. Record and edit locally without it. Public hosted signup at vidcapture.stream is not available. Deploy this service in your own Cloudflare account, never against someone else's database or storage.

You need Node/npm, a Cloudflare account with Workers, D1, and R2 access, and authenticated Wrangler. Cloudflare usage charges may apply. Consult the current [Cloudflare D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/) and [R2 setup](https://developers.cloudflare.com/r2/get-started/) for account requirements.

From the repository:

```sh
cd cloud
npm ci
npx wrangler login
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create my-vidcapture
npx wrangler r2 bucket create my-vidcapture-videos
```

Edit wrangler.jsonc: set database_id to the new database's ID. Give the Worker and bucket your own unique names if necessary, and make the bindings match. Set SITE_ORIGIN to your Worker's HTTPS URL, with no trailing slash. Use your own workers.dev subdomain or configured custom domain. The example contains no production resource IDs.

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
npx wrangler types
npm run check
cd ..
node scripts/pair-sharing.cjs https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev /absolute/path/to/vidcapture/cloud/wrangler.jsonc --remote
```

Pairing creates a random device key in ~/.local/state/capture/publishing.json with owner-only permissions, sends only its SHA-256 hash to your D1 database, and never prints the key. It refuses to overwrite an existing connection or provision a key for vidcapture.stream. Keep the key private. Restart VidCapture and open **Video library**. Only share synthetic test footage until you have verified your deployment's watch, seek, delete, and signed-out access behavior.

The key grants access to the videos belonging to that device. It grants no Cloudflare administration access. There is no public registration endpoint. The browser library signs in from the desktop with a short-lived one-use code. Do not expose D1 or the R2 bucket publicly.

This release's local pairing path was tested against an isolated local D1 database. A fresh third-party Cloudflare account deployment was not tested. Browser login cookies require HTTPS. The public watch link is unlisted, not password-protected; anyone holding it can watch and download. Removing the shared video does not remove your original local file.

For changes to cloud/src, regenerate types with `npx wrangler types`, then run `npm run check`. Never commit device keys or personal deployment configuration.
