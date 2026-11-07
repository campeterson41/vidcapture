# Self-hosted sharing

Optional advanced setup. Most people share through a free vidcapture.stream account and never need this. Self-hosting keeps every shared video in your own Cloudflare account. Deploy it only in your own account, never against someone else's database or storage.

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

Account email (confirming addresses, password resets, and sign-in links) uses [Cloudflare Email Sending](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/). Set EMAIL_FROM and the send_email sender to an address on a domain you have set up for it. Pairing below does not need email, so you can skip this until you want accounts.

To send through Amazon SES instead, verify your sending domain in SES and add the Worker secrets SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY (`npx wrangler secret put SES_ACCESS_KEY_ID`), plus SES_REGION if it is not us-east-1. Use an IAM key limited to sending email. When those secrets are set, the Worker uses SES; otherwise it uses the send_email binding.

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
npx wrangler types
npm run check
cd ..
node scripts/pair-sharing.cjs https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev /absolute/path/to/vidcapture/cloud/wrangler.jsonc --remote
```

Pairing creates a random device key in ~/.local/state/capture/publishing.json with owner-only permissions, sends only its SHA-256 hash to your D1 database, and never prints the key. It refuses to overwrite an existing connection or provision a key for vidcapture.stream. Keep the key private. Restart VidCapture and open **Video library**. Only share synthetic test footage until you have verified your deployment's watch, seek, delete, and signed-out access behavior.

The key grants access to the videos belonging to that device. It grants no Cloudflare administration access. The browser library signs in from the desktop with a short-lived one-use code. Your deployment also serves the same sign-up and log-in pages as vidcapture.stream, so anyone who finds its URL can create an account there; each account gets its own storage quota. Do not expose D1 or the R2 bucket publicly.

Local pairing was tested against an isolated local D1 database. A fresh third-party Cloudflare account deployment was not tested. Browser login cookies require HTTPS. The public watch link is unlisted, not password-protected; anyone holding it can watch and download. Removing the shared video does not remove your original local file.

For changes to cloud/src, regenerate types with `npx wrangler types`, then run `npm run check`. Never commit device keys or personal deployment configuration.
