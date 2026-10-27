# Voice, photos, drawing and search

Most of this works with the keys already in Doppler. `/doctor` lists each one as on or off.

| What | Works with | Extra setup |
|---|---|---|
| Hearing voice notes | Your Groq key (Whisper) or Gemini key | none |
| Talking back (voice notes) | Your Gemini key | none. The Dockerfile installs ffmpeg so replies arrive as proper voice bubbles |
| Looking at photos | Your Gemini key, Groq as a fallback | none |
| Web search | Your Gemini key (Google Search), Groq as a fallback | none |
| Drawing pictures | Cloudflare (free) | two Doppler values, below |

## Drawing with Cloudflare (free, about 200 pictures a day)

Gemini's image models aren't on the free tier, so lifeline draws with Cloudflare Workers AI, which has a free daily allowance.

1. Make a free account at dash.cloudflare.com.
2. Copy your **Account ID** (Workers & Pages overview, right-hand side, or the URL after `dash.cloudflare.com/`).
3. My Profile, API Tokens, Create Token, use the **Workers AI** template. Copy the token.
4. In Doppler: `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

Without them, lifeline falls back to Pollinations, which needs no key but is slow, limited and may watermark. Set `ENABLE_POLLINATIONS=false` to turn that off.

If your Gemini project has billing on, set `GEMINI_IMAGE_MODEL` to an image model id from Google's model list to draw with Gemini instead.

## Daily allowances

So one person can't use up the circle's free quotas, each person gets, per day: 15 pictures, 80 spoken replies, 60 photos looked at, 60 web searches, 200 voice notes heard. The bot says so in words when someone reaches one.

## Voices

Say "use a calm voice" or tap /voice. Choices: warm (default), upbeat, calm, deep, lively, gentle, bright, easy. "Voice replies always", "voice replies on" (talk back when you send a voice note, the default) and "text only" set when lifeline talks.

## Model ids

These change; each is a Doppler value with a sensible default:

- `GROQ_STT_MODEL` (whisper-large-v3-turbo)
- `GEMINI_TTS_MODEL` (gemini-3.8-flash-tts), `GEMINI_TTS_FALLBACK_MODEL` (gemini-2.5-flash-preview-tts), `TTS_VOICE` (Sulafat)
- `GROQ_VISION_MODEL` (meta-llama/llama-4-scout-17b-16e-instruct)
- `GROQ_SEARCH_MODEL` (groq/compound)
- `CLOUDFLARE_IMAGE_MODEL` (@cf/black-forest-labs/flux-1-schnell)
