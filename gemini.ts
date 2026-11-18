import WebSocket from 'ws';
export { validate,audioMessage,answer } from './gemini-core.ts';
const liveURL='wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function transcribe(key: string, callbacks: {
  ready(): void; transcript(text: string): void; closed(): void;
}) {
  const endpoint = new URL(process.env.NODE_ENV === 'test' ? process.env.TEST_REALTIME_URL! : liveURL);
  endpoint.searchParams.set('key', key);
  const ws = new WebSocket(endpoint, {handshakeTimeout: 15000});
  let finalized = '';
  ws.on('open', () => ws.send(JSON.stringify({setup: {
    model: 'models/gemini-3.5-transcribe-live',
    generationConfig: {responseModalities: ['TEXT']},
    inputAudioTranscription: {languageCodes: []}
  }})));
  ws.on('message', raw => {
    try {
      const event = JSON.parse(raw.toString());
      if (event.setupComplete) callbacks.ready();
      if (event.error) return ws.close();
      const content = event.serverContent;
      if (content?.inputTranscription?.text) {
        finalized = (finalized + content.inputTranscription.text + '\n').slice(-16000);
        callbacks.transcript(finalized.trimEnd());
      } else if (content?.interimInputTranscription) {
        callbacks.transcript((finalized + content.interimInputTranscription.text).slice(-16000));
      }
    } catch { ws.close(); }
  });
  ws.on('error', () => {}); // The close event reports failure without logging credentials.
  ws.on('close', callbacks.closed);
  return ws;
}
