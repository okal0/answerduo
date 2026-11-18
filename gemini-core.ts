import { Buffer } from 'node:buffer';
const flashURL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash';
export class GeminiModelUnavailable extends Error {}

export function validate(key: string) {
  return fetch(flashURL, {headers: {'x-goog-api-key': key}, signal: AbortSignal.timeout(15000)});
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

export async function answer(key: string, instructions: string, prompt: string, image: string | undefined,
  signal: AbortSignal, onText: (text: string) => void, fallback = false) {
  const parts: object[] = [{text: prompt}];
  if (image) parts.push({inlineData: {mimeType: 'image/jpeg', data: image.slice(image.indexOf(',') + 1)}});
  const lite = !image && !fallback;
  const modelURL = lite ? flashURL + '-lite' : flashURL;
  const response = await fetch(modelURL + ':streamGenerateContent?alt=sse', {
    method: 'POST', signal, headers: {'x-goog-api-key': key, 'Content-Type': 'application/json'},
    body: JSON.stringify({systemInstruction: {parts: [{text: instructions}]},
      contents: [{role: 'user', parts}], generationConfig: {maxOutputTokens: image ? 3200 : 320, thinkingConfig: {thinkingLevel: 'minimal'}}})
  });
  if (lite && [403,404,429,500,502,503,504].includes(response.status)) {
    await response.body?.cancel();
    throw new GeminiModelUnavailable('Gemini Flash-Lite unavailable (' + response.status + ').');
  }
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
    if (candidate?.finishReason === 'STOP' || candidate?.finishReason === 'MAX_TOKENS') complete = true;
  }
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      consume(line);
      if (complete) return;
    }
  }
  consume(pending);
  if (!complete) throw Error('Gemini answer interrupted. Tap again to retry.');
}
