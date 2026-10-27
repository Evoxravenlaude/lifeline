# How lifeline looks

## The idea

lifeline keeps your day. Pip is a tortoise who carries what you tell him and walks through the day at his own pace. So the web app opens on **the path**: one illustrated landscape of today, drawn from your real data.

- The sky follows the real hour where you are: dawn, noon, dusk, then night with stars. The sun or moon sits where it actually is.
- The path runs across the hills from morning to midnight. Every reminder, event, class and dose today is a lantern beside it. Lanterns behind you are ticked and dim; lanterns ahead are lit.
- Pip walks on the path at the position of *now*. If something waits on your yes, he stops and holds up his watch.
- Quiet hours are the stretch of path where the lamps are off.

Everything else in the app is **the shell**: what Pip is carrying. Each kept thing is a letterpress card: a 1.5px ink edge with a flat offset plate behind it, in the colour of its kind (dose, trip, deadline, list…). A page of cards reads like a stack of colour-coded stationery.

This takes two things from the projects next door. From `.hood`: the data-driven scene (lit windows are names; here, lit lanterns are your day), palette and day-or-night chosen separately, a boot sequence that draws the mark, and a theme change that opens as a circle from the control you pressed. From Pulse: the window-and-plate card, colour per kind, and the phone tab bar with safe areas.

## Tokens

Five palettes, each with a day and a night setting. The palette changes the paint; the shapes stay.

| Palette | Day paper / ink / accent / metal | Night paper / ink / accent / metal |
|---|---|---|
| Manor (default) | linen #EDE6D6 / #1F1B16 / bottle green #2D4A3A / brass #A8843F | #0F1411 / #ECE5D3 / #8DB39A / #D2B26E |
| Claret | bone #F1EBE3 / #241618 / oxblood #6B1F2A / gold #B48A3C | #170D10 / #F3E8DD / #D88A93 / #E3C27E |
| Riviera | sand #EFE9DC / #18212E / navy #1F3550 / #B08A4E | #0D1420 / #E9E4D8 / #8FB0D6 / #D9BC82 |
| Tobacco | #EEE5D6 / #23180F / leaf #5A3A22 / amber #B7792E | #17110C / #F0E4CF / #D9A066 / #E8B866 |
| Ivory | #F2F0EA / #141414 / #141414 / #9C7F45 | #0B0B0A / #EFEDE6 / #EFEDE6 / #C9A866 |

Kinds (the card plates), muted heritage pastels by day and deep versions by night: reminder mustard, event dusty blue, dose sage, class heather, trip tan, money eucalyptus, hackathon rose clay, scout lavender, list stone.

**Type.** The faces an old house prints with. Libre Caslon Display for what's engraved: headings and the wordmark (Caslon is the English printer's face of the 1700s). EB Garamond for everything read and tapped, at 18px because Garamond sits small; italic Garamond is the voice for your own words and Pip's lines. Old-style figures in prose, lining tabular figures for times, amounts and counts. Self-hosted, no font CDN. Scale on a 1.25 ratio: 14, 16, 20, 25, 31, 39, 49, display up to 96 on wide screens.

**Shape.** Cards: 10px radius, 1.5px ink edge, 4px offset plate, no blur shadows anywhere. Buttons share the edge; the primary one is filled with the accent. Pills only for chips.

## Rules

- Copy follows `docs/VOICE.md`. No all-caps labels, no mono labels, no arrows on buttons.
- Motion answers the person: a card lifting onto its plate when pressed, the circle reveal on theme change, Pip's states. The only motion nobody asked for is the boot (once per visit) and Pip breathing.
- Every view has a real empty state that says what to type.
- Works from 360px up. On phones a tab bar at the bottom; ⌘K or / opens "say anything" from any page.
- Respects reduced motion, keeps visible focus, and every pairing of text and paint passes AA.
