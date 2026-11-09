# InterviewDuo interview workspace

InterviewDuo pairs a Chrome laptop host with a mobile browser. Run one long-lived Node.js 24 server. Session state and keys live in that process. Restarting it ends every session.

## Run locally

Install Node.js 24 and pnpm, then run these commands in the project directory.

```sh
pnpm install --frozen-lockfile
node server.ts
```

Open http://localhost:3000 in desktop Chrome. For the relay integration test run `node --test test.ts`. The test uses a simulated provider and requires no key.

## Use a physical phone during development

1. Install Cloudflare's cloudflared CLI and run `cloudflared tunnel --url http://localhost:3000`. Copy the public HTTPS origin it prints. Keep the tunnel open.
2. Stop the local Node server. In PowerShell, set `$env:PUBLIC_ORIGIN='https://YOUR-TUNNEL.trycloudflare.com'` using the actual origin without a trailing slash. Run `node server.ts` again.
3. Open **that HTTPS origin on the laptop**. The host and companion use the same origin for HTTP and WebSockets. A phone on cellular can scan the QR directly. A localhost QR only works on the laptop.

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

1. Choose OpenAI or Google Gemini on the laptop. Try an invalid key, then validate a key for the selected provider with access to its models. Changing providers clears the key. Select a meeting tab without audio and confirm the reselect instruction. Share it again with **Also share tab audio** checked. Wear headphones, play speech in the meeting tab and watch the input meter. The app requests no microphone.
2. Select a different window as the visual source. Start the session. Scan the QR in Safari or Chrome. Try the same link in another browser to check single use. Unused links expire after two minutes and can be refreshed on the host.
3. Speak a question on the remote meeting side. Expand the phone transcript, scroll back, then tap **Answer question**. Check that text streams in and duplicate taps are disabled. Pause the laptop, speak again and confirm new audio stops. Resume.
4. Change the visual window's contents between two **Analyze screen** taps. Compare the answers. Revoke only visual sharing and retry. The phone should show **Select a window on your laptop**. Keep speaking in the meeting during revocation and reselection and check that transcription continues.
5. Temporarily disconnect the phone and reconnect in the same browser tab. Check that the question and answer return. Test in portrait on a narrow iPhone, including the bottom safe area. End the session during generation. Confirm capture indicators disappear and the phone credential is rejected.

## Data flow

The optional **CV or background notes** field accepts up to 20,000 characters on the laptop. Import a text-based PDF, DOCX or UTF-8 TXT up to 5 MB, or type directly. The laptop extracts and appends editable text locally. Only the notes text is sent when you request an answer. Scanned PDFs require text extraction elsewhere. You can edit or clear it between answers. **Answer question** sends its current text through the relay to the selected provider along with the transcript. The phone receives the generated answer, which may reference the notes. The raw notes stay out of pairing links, session snapshots and screen-analysis requests.

The laptop sends its provider key over HTTPS to the trusted Node server for validation and again at session start. For OpenAI sessions, the server authenticates to OpenAI with a Bearer header. It checks access to `gpt-4.1-mini` using the Models API. Billing and transcription access are exercised by actual requests. No key is embedded in pairing links, persisted by the app or intentionally logged.

Chrome captures meeting **tab audio**, downmixes it to mono PCM16 at 24 kHz and sends it over the authenticated host WebSocket. In OpenAI sessions the server forwards chunks to OpenAI Realtime using `gpt-live-transcribe`. The host commits turns after a quiet interval or 20 seconds. The phone receives transcript text. Selecting a visual source creates an independent capture stream on the laptop. Each analysis command samples its current frame into a new JPEG and sends it through the trusted server to the Responses API. Both OpenAI actions use `gpt-4.1-mini`, with streaming and `store:false`. The server and the selected provider receive transcript context and, for analysis, the requested image. OpenAI's account-level data controls also apply.

For Google Gemini, use a [Gemini API key from Google AI Studio](https://aistudio.google.com/apikey). The relay validates the key against the Flash model, converts the audio to 16 kHz mono and forwards it to `gemini-3.5-transcribe-live`. Interim captions update until Google returns a final utterance. Both phone actions stream text from `gemini-3.5-flash`. Screen analysis includes a fresh inline JPEG. Google receives the key in the REST authentication header and in the server-to-Google Live WebSocket handshake URL. Keep outbound request URLs out of proxy logs. Model availability and quota depend on your Google project. [Live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) · [Streaming generation](https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent)

The server exchanges a single-use fragment token for a separate phone credential. The phone retains that credential in sessionStorage for reconnection within its tab. The host credential stays in laptop memory. The relay retains recent transcript text, the active question and answer. Ending or losing the host connection closes both sockets and cancels provider work. Get appropriate agreement before sharing meeting content with the provider.

[OpenAI Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) · [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)


