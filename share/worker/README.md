# Replay share Worker

Serves shared replays: stores encrypted replay blobs in R2 and serves the viewer page that
decrypts and plays them. One origin for both, so CORS never applies.

**Deploying your own instance is a first-class path.** Nothing here is specific to any one
account, and the extension can be pointed at your instance from Settings without a code change.

## What it does

| Route | Behaviour |
|---|---|
| `PUT /u` | Validate token and size cap, generate a 128-bit id, stream the body to R2, return `{id}` |
| `GET /b/<id>` | Stream the object back; 404 when absent or expired |
| `GET /` | The viewer page, from `public/` |

The Worker never sees a decryption key. Keys live in the URL fragment, which browsers do not
send to servers, so what R2 holds is ciphertext this Worker cannot read.

There is **no delete route**. Shares are removed by an R2 lifecycle rule and cannot be revoked
early. To honour a takedown request, delete the object directly:
`npx wrangler r2 object delete <bucket>/<id>`.

## Deploy your own

Roughly ten minutes from a clean checkout.

### 1. Prerequisites

A Cloudflare account and `npx wrangler`. Note that **R2 requires a payment method on file even
to use the free tier** — you will not be charged inside the free limits, but you cannot enable
R2 without adding a card.

### 2. Credentials

Never put these in a file that git tracks.

```sh
cp env.example .env      # .env is gitignored
# fill in CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, then export them
set -a; . ./.env; set +a
```

The API token needs **Workers Scripts: Edit** and **R2: Edit**.

### 3. Configure

```sh
cp wrangler.toml.example wrangler.toml    # also gitignored
```

Set `bucket_name` to whatever you want to call your bucket. Adjust `MAX_UPLOAD_BYTES` if you
want a cap other than 12 MB — the largest replay measured so far is 3.59 MB, so 12 MB is roughly
3× headroom.

### 4. Create the bucket

```sh
npx wrangler r2 bucket create <your-bucket-name>
```

### 5. Set the lifecycle rule — do not skip this

In the Cloudflare dashboard, add a lifecycle rule on the bucket to **delete objects 7 days after
creation**.

Sharing has no revocation, so this rule is the only thing that ever deletes anything. Without it
your bucket grows forever and shared replays never expire.

### 6. Set the upload token

```sh
npx wrangler secret put UPLOAD_TOKEN
```

Any random string. Understand what this is: the same value ships inside a distributed browser
extension, so it is **public by construction** and stops only casual drive-by use. It is a speed
bump, not authentication.

### 7. Deploy

```sh
sh sync-assets.sh
npx wrangler deploy
```

`sync-assets.sh` copies the vendored rrweb bundle and the shared replay modules into `public/`.
Those copies are gitignored — git holds one canonical copy at the repo root.

Allow 20–30 seconds for a deploy to propagate. Testing immediately after `wrangler deploy` hits
the previous version and produces confusing results.

Security headers for the viewer page come from `public/_headers`, not from the Worker. Static
assets are served *before* the Worker runs, so headers set in Worker code never reach the viewer
page — only `GET /b/<id>`, which the Worker does serve.

### 8. Rate limiting

Already configured — the `[[ratelimits]]` binding in `wrangler.toml` limits `PUT /u` per client
IP, and the Worker applies it before checking the token so token guessing is throttled too.

This deliberately does **not** use a WAF rate-limiting rule. Those are zone-scoped, so they do
not apply to a `*.workers.dev` deployment. If you put your instance behind a domain you own on
Cloudflare, a WAF rule becomes available as an additional layer.

The rate limit is what actually carries the abuse load; the size cap only gives legitimate
replays headroom.

### 9. Stay on the Workers Free plan

**This is deliberate — read `docs/adr/0001-remain-on-the-workers-free-plan.md` before changing
it.** The free plan's 100,000 requests/day limit stops serving until 00:00 UTC at no charge, and
it is the only hard spend ceiling Cloudflare offers. Budget alerts only send email; they do not
pause anything. Upgrading to the paid plan looks like routine capacity work and silently removes
the only thing protecting your card.

### 10. Point the extension at it

Copy your `*.workers.dev` hostname into the extension's Settings → Share endpoint.

## Local development

```sh
sh sync-assets.sh
npx wrangler dev
```

`wrangler dev` uses a local R2 simulation by default, so uploads will not touch your real bucket.
