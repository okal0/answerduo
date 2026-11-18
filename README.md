# AnswerDuo interview workspace

AnswerDuo pairs a Chrome computer host with a mobile browser. Run one long-lived Node.js 24 server. Session state and keys live in that process. Restarting it ends every session.

## Run locally

Install Node.js 24 and pnpm, then run these commands in the project directory.

```sh
pnpm install --frozen-lockfile
node server.ts
```

Open http://localhost:3000 for the public site, or http://localhost:3000/app for the computer workspace. Run `pnpm test` for the Node and Cloudflare backend suites. Run `pnpm test:browser` with Google Chrome installed for the host-and-phone browser test (or set `BROWSER_CHANNEL=msedge` to use Microsoft Edge). It uses two isolated browser contexts, synthetic audio and a simulated provider to check pairing, the first answer, host recovery and deliberate session end. These tests require no provider key.

## Use a physical phone during development

1. Install Cloudflare's cloudflared CLI and run `cloudflared tunnel --url http://localhost:3000`. Copy the public HTTPS origin it prints. Keep the tunnel open.
2. Stop the local Node server. In PowerShell, set `$env:PUBLIC_ORIGIN='https://YOUR-TUNNEL.trycloudflare.com'` using the actual origin without a trailing slash. Run `node server.ts` again.
3. Open **that HTTPS origin on the computer**. The host and companion use the same origin for HTTP and WebSockets. A phone on cellular can scan the QR directly. A localhost QR only works on the computer.

## HTTPS deployment

On a public Linux host with Node.js 24, pnpm and Caddy, point your domain's DNS to the host and allow inbound TCP ports 80 and 443. Copy this project there, install dependencies and run the server under your service manager with the following command (replace the example domain).

```sh
pnpm install --frozen-lockfile
PUBLIC_ORIGIN=https://interview.example.com PORT=3000 node server.ts
```

Use this Caddyfile and run `caddy run --config ./Caddyfile`. Caddy terminates TLS and proxies WebSocket upgrades. Restrict external access to the backend port. Keep one server instance for in-memory pairing and reconnects. Use a trusted host and proxy with request body logging disabled.

```caddyfile
interview.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

## Two-device acceptance check

1. Choose OpenAI or Google Gemini on the computer. Try an invalid key, then validate a key for the selected provider with access to its models. Changing providers clears the key. Select a meeting tab without audio and confirm the reselect instruction. Share it again with **Also share tab audio** checked. Wear headphones, play speech in the meeting tab and watch the input meter. The app requests no microphone.
2. Select a different window as the visual source. Start the session. Scan the QR in Safari or Chrome. Try the same link in another browser to check single use. Unused links expire after two minutes and can be refreshed on the host.
3. Speak a question on the remote meeting side. Expand the phone transcript, scroll back, then tap **Answer question**. Check that text streams in and duplicate taps are disabled. Pause the computer, speak again and confirm new audio stops. Resume.
4. Change the visual window's contents between two **Analyze screen** taps. Compare the answers. Revoke only visual sharing and retry. The phone should show **Select a window on your computer**. Keep speaking in the meeting during revocation and reselection and check that transcription continues.
5. Temporarily disconnect the phone and reconnect in the same browser tab. Check that the question and answer return. Test in portrait on a narrow iPhone, including the bottom safe area. End the session during generation. Confirm capture indicators disappear and the phone credential is rejected.

## Data flow

The optional **CV or background notes** field accepts up to 20,000 characters on the computer. Import a text-based PDF, DOCX or UTF-8 TXT up to 5 MB, or type directly. The computer extracts and appends editable text locally.  Scanned PDFs require text extraction elsewhere. You can edit or clear it between answers. The host syncs notes and preparation settings to session memory on the relay. Tapping **Get answer** sends them to the selected provider with the transcript. The phone receives the generated answer, which may reference the notes. The raw notes stay out of pairing links, session snapshots and screen-analysis requests.

The computer sends its provider key over HTTPS to the trusted Node server for validation and again at session start. For OpenAI sessions, the server authenticates to OpenAI with a Bearer header. It checks access to `gpt-4.1-mini` using the Models API. Billing and transcription access are exercised by actual requests. No key is embedded in pairing links, persisted by the app or intentionally logged.

Chrome captures meeting **tab audio**, downmixes it to mono PCM16 at 24 kHz and sends it over the authenticated host WebSocket. In OpenAI sessions the server forwards chunks to OpenAI Realtime using `gpt-live-transcribe`. The host commits turns after about 400 ms of quiet following speech or after 20 seconds. The phone receives transcript text. Selecting a visual source creates an independent capture stream on the computer. Each analysis command samples its current frame into a new JPEG and sends it through the trusted server to the Responses API. Both OpenAI actions use `gpt-4.1-mini`, with streaming and `store:false`. The server and the selected provider receive transcript context and, for analysis, the requested image. OpenAI's account-level data controls also apply.

For Google Gemini, use a [Gemini API key from Google AI Studio](https://aistudio.google.com/apikey). The relay validates the key against the Flash model, converts the audio to 16 kHz mono and forwards it to `gemini-3.5-transcribe-live`. Interim captions update until Google returns a final utterance. Get answer streams from `gemini-3.5-flash-lite`. If that model is unavailable or sends no text within six seconds, the relay makes one fallback attempt with `gemini-3.5-flash`. Screen analysis uses `gemini-3.5-flash`. Screen analysis includes a fresh inline JPEG. Google receives the key in the REST authentication header and in the server-to-Google Live WebSocket handshake URL. Keep outbound request URLs out of proxy logs. Model availability and quota depend on your Google project. [Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) · [Streaming generation](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)

The server exchanges a single-use fragment token for a separate phone credential. The phone retains that credential in sessionStorage for reconnection within its tab. The host credential stays in computer memory. The relay retains recent transcript text, the active question and answer. Ending or losing the host connection closes both sockets and cancels provider work. After an unexpected disconnect, the open computer page keeps your preparation in memory and stops sharing. Enter your key again, select audio, start a new session and pair the phone with its new code. Ending the session deliberately clears the preparation. Get appropriate agreement before sharing meeting content with the provider.

[OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) · [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)



## Accounts, guest trials and administration

Account and traffic data are stored in SQLite at `data/accounts.sqlite`. Set `ACCOUNTS_DB` to an absolute persistent location in deployment. Run one Node process. Back up this database. Interview transcripts, provider keys, screenshots and CV text continue to live in memory.

Anonymous guests receive 20 minutes of cumulative session time. Pauses within an open session count; time between sessions does not. After the preview ends, the computer directs guests to registration. Registering starts a fresh seven-calendar-day free trial with no credit card required; the deadline is stored against the account and does not renew on login. Registering during a guest session extends its deadline. Existing guest identities receive a fresh preview once through the `guest-preview-v1` migration; existing registered trial deadlines are preserved. After the registered trial expires, access requires a license; purchasing and activation remain unimplemented. Admin access is exempt. Clearing cookies can restart the guest preview. Email verification is not implemented, so multiple registrations remain possible. Guest identity counts include expired identities and deployment tests; they are separate from unique browser visitors.

Create the owner administrator locally using PowerShell. The command reads the password through stdin instead of putting it in process arguments. Use the same `ACCOUNTS_DB` as the running server.

```powershell
$adminEmail = Read-Host 'Admin email'
$adminPassword = Read-Host 'Admin password (12 characters minimum)' -AsSecureString
$plainPassword = [System.Net.NetworkCredential]::new('', $adminPassword).Password
@{email=$adminEmail;password=$plainPassword} | ConvertTo-Json -Compress | node create-admin.ts
$plainPassword = $null
```

Sign in at `/account`, then open `/admin`. This dashboard counts guests, registered accounts, active paid memberships, session starts and daily page traffic. There is no downloadable application, so downloads are shown as unavailable. Admin access is checked on the server.

## Paid membership configuration (postponed)

Planned USD prices are $4 per month or $21 once for a lifetime license. Both paid licenses have no hourly usage cap and require the customer’s own AI provider key. Checkout remains paused.

Public checkout and webhook endpoints are paused even when payment credentials are set. The Paddle adapter is retained for future work. Paddle is the provisional payment integration. Confirm seller eligibility and complete approval before enabling production. Checkout uses a recurring Paddle price. The displayed price must match that price, including billing period. Configure these environment variables through your hosting secret manager.

- `PADDLE_API_KEY` — server API key
- `PADDLE_PRICE_ID` — recurring membership price
- `PADDLE_WEBHOOK_SECRET` — destination secret for `https://YOUR-DOMAIN/api/billing/webhook`
- `PADDLE_ENV` — `production` for real payments, otherwise sandbox
- `MEMBERSHIP_PRICE_LABEL` — customer-facing price such as `$4 / month`

Subscribe the destination to subscription activated, updated, canceled and paused events. Checkout requires a registered account and associates the transaction with that account server-side. Access is granted from signed subscription events, never from returning to a success URL. Duplicate and older subscription events are ignored. Use Paddle's cancellation links and customer portal supplied in subscription emails. When billing secrets are absent the pricing page clearly shows that membership checkout is pending.

Before public launch, test a real sandbox checkout, renewal, cancellation and a provider timeout. Configure account email verification and password recovery with a verified email service. These email workflows are not implemented yet. An owner can currently create an account locally, but there is no password recovery UI.

## Cloudflare Free deployment

Live URL — https://app.answerduo.workers.dev

The Node.js server remains available for local development. The Cloudflare build uses a Worker for routing/static assets, a SQLite-backed AccountStore Durable Object for account and trial data, and one InterviewRoom Durable Object per capture session. The deployment requires neither a paid database nor a container.

### Build and test

    pnpm install --frozen-lockfile
    pnpm run build:cloudflare
    pnpm run test:cloudflare
    pnpm test
    pnpm run dev:cloudflare

The Cloudflare preview runs at http://localhost:8787. Use a public HTTPS deployment for a physical phone. The /app page is the computer host, /phone is the paired companion, /account handles sign-in, and /admin is the protected owner dashboard.

### Deploy updates

    pnpm exec wrangler login
    pnpm run deploy:cloudflare

The checked-in configuration targets the owner's Cloudflare account and the Worker named app under answerduo.workers.dev. For another account, change account_id and configure its workers.dev subdomain first. scripts/configure-cloudflare-domain.mjs is an explicit one-time helper for the original deployment. It refuses to replace an existing different subdomain.

### Existing owner administrator

Import the local administrator with the following command.

    node scripts/migrate-cloudflare-admin.mjs

This reads only the local administrator's email and salted password hash, and supplies them through stdin to Wrangler's encrypted secret store as ADMIN_EMAIL and ADMIN_PASSWORD_HASH. The existing password works on the deployed /account page after import. Local guest accounts and analytics are not automatically copied to Cloudflare. The admin email is reserved from public signup even before setup completes.

New account passwords use PBKDF2-SHA256 with 100,000 iterations through Web Crypto inside AccountStore. Legacy owner passwords are verified with a portable scrypt implementation inside the Durable Object. Both keep password hashing out of the ordinary Free Worker request CPU budget.

### Session and trial behavior

Provider keys, CV text, screenshots, transcripts, and answers are held in InterviewRoom memory. Persisted room metadata includes credential hashes and deadlines, and excludes provider keys and interview content. Ending a session closes provider connections, aborts generation, removes room metadata, and releases the trial lease. A Cloudflare runtime restart ends an in-memory interview session. Start a new session on the computer if this occurs. A brief phone disconnect restores the question and answer while the host session remains running.

Guest usage is checkpointed every 30 seconds instead of every second. A server alarm and per-message deadline checks enforce the trial. After an unclean room failure, its account lease expires within 70 seconds. Leases prevent overlapping sessions; access expires at the stored calendar deadline independently of session usage. One guest identity can run one active session at a time. Admin sessions have an eight-hour maximum session length.

Account and trial data persist across deployments in AccountStore SQLite. Page traffic is aggregated by date and retained for 90 days. The license-key-only customer flow remains future work. Account login, a 20-minute guest preview, and a seven-day registered free trial are available. Payment and billing-webhook endpoints remain paused.

### Free limits and verification

A 30-second checkpoint is about 120 account row updates per active session-hour. Additional rows are written for sign-in, visits, and rate limits. Each interview currently keeps its object active while relaying audio, so duration remains an important quota. Cloudflare's Free allowances are account-wide, reset daily, and can stop operations when exhausted. Review usage in Workers & Pages before inviting more users. Deployment performs no billing-plan upgrade.

Cloudflare tests run the Worker and Durable Objects with Miniflare/workerd and simulated external providers. They cover QR decoding, one-use pairing, distinct credentials, audio forwarding, both provider streams, fresh image payloads, reconnects, trial termination, overlapping trials, legacy admin login and CSRF rejection. Real meeting capture, paid model access, and physical phone reliability still require live testing.

Further documentation
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/

### Launch access policy

`access-policy.ts` defines the 20-minute guest preview and seven-day registered trial. Guest limits measure cumulative session runtime and registered limits use a stored calendar deadline starting at signup. The two-minute expiry test is disabled. Public signup, FAQ and pricing copy explicitly say no credit card is required. Admin access is exempt; license activation remains unimplemented.
