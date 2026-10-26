/** Voice notes → text. OpenAI transcription (~$0.003/min). Telegram sends OGG/Opus. */
import { config } from "./config.js";

export async function transcribe(audio: Buffer, filename = "voice.ogg"): Promise<string | null> {
  if (!config.openaiKey) return null;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/ogg" }), filename);
  form.append("model", config.sttModel);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${config.openaiKey}` },
    body: form,
  });
  if (!r.ok) throw new Error(`transcription failed: ${r.status}`);
  const j: any = await r.json();
  return (j.text ?? "").trim() || null;
}
