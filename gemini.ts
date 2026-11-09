import WebSocket from 'ws';

const modelURL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash';
const liveURL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export function validate(key: string) {
  return fetch(modelURL, {headers: {'x-goog-api-key': key}, signal: AbortSignal.timeout(15000)});
}

// Each 100 ms worklet frame contains 2400 mono samples. Average each
// 1.5-sample interval to produce 1600 samples at Gemini's input rate.
export function audioMessage(frame: Buffer) {
  const pcm = Buffer.alloc(Math.floor(frame.length / 6) * 4);
  for (let src = 0, dst = 0; dst < pcm.length; src += 6, dst += 4) {
    const middle = frame.readInt16LE(src + 2);
    pcm.writeInt16LE(Math.round((2 * frame.readInt16LE(src) + middle) / 3), dst);
    pcm.writeInt16LE(Math.round((middle + 2 * frame.readInt16LE(src + 4)) / 3), dst + 2);
  }
  return {realtimeInput: {audio: {mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64')}}};
}

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

export async function answer(key: string, instructions: string, prompt: string, image: string | undefined,
  signal: AbortSignal, onText: (text: string) => void) {
  const parts: object[] = [{text: prompt}];
  if (image) parts.push({inlineData: {mimeType: 'image/jpeg', data: image.slice(image.indexOf(',') + 1)}});
  const response = await fetch(modelURL + ':streamGenerateContent?alt=sse', {
    method: 'POST', signal, headers: {'x-goog-api-key': key, 'Content-Type': 'application/json'},
    body: JSON.stringify({systemInstruction: {parts: [{text: instructions}]},
      contents: [{role: 'user', parts}], generationConfig: {maxOutputTokens: image ? 3200 : 1200, thinkingConfig: {thinkingLevel: 'minimal'}}})
  });
  if (!response.ok || !response.body) throw Error('Gemini request failed (' + response.status + '). Check model access and quota.');
  let pending = '', complete = false;
  function consume(line: string) {
    if (!line.startsWith('data:')) return;
    const event = JSON.parse(line.slice(5));
    const candidate = event.candidates?.[0];
    if (event.error || event.promptFeedback?.blockReason) throw Error('Gemini could not answer this request.');
    for (const part of candidate?.content?.parts ?? []) {
      if (part.text && !part.thought) onText(part.text);
    }
    if (candidate?.finishReason === 'STOP') complete = true;
  }
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) consume(line);
  }
  consume(pending);
  if (!complete) throw Error('Gemini answer interrupted. Tap again to retry.');
}
