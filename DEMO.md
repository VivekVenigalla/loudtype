# Loudtype: judging-table demo

**One line:** Live captions that sound like you.
**The idea in one breath:** Your voice has volume, length and feeling. Normal captions throw all three away. Loudtype keeps them, live on stream.

The demo's job: within 30 seconds, the judge hears their *own* whisper and shout turn into type. Everything else supports that moment.

---

## Table setup (do this before judges arrive)

| Item | Detail |
|---|---|
| Laptop (faces you) | Control panel `http://localhost:7777/control/`, Director's View open |
| Second screen (faces judge) | Overlay full screen: `http://localhost:7777/overlay/` over a game clip, or OBS with the overlay on a scene |
| Mic | Headset or clip-on mic **for the judge**. Never the laptop mic; the venue is loud |
| Warm-up | Click **Start** once and talk for 10 s so the emotion model is loaded (it takes a few seconds the first time) |
| Backup | **Play demo clip** works fully offline if Wi-Fi or ElevenLabs fails |

Before each judge: click **New judge**. That clears the screen, forgets the last voice, and shows prompt card 1 on the judge's screen. Then you only press **Next prompt ▶**.

---

## The 2-minute script

| Time | On screen | You say |
|---|---|---|
| 0:00–0:15 | Overlay playing the **demo clip** (whisper → shout → "nooooo" → sad line) | Nothing. Let them watch. |
| 0:15–0:25 | | "Your voice has volume, length and feeling. Captions throw all three away. Loudtype keeps them, live." |
| 0:25–0:35 | Click **New judge**, hand over the mic. Card 1: *"Hi, I'm one of the judges at Hacklanta today."* | "Say this normally. It's learning what *your* normal sounds like." (the calibration bar fills) |
| 0:35–0:50 | **Next ▶** Card 2: whisper *"this is the best day ever"* | "Now whisper it." → small, light, green ● (calm) |
| 0:50–1:05 | **Next ▶** Card 3: *SHOUT it* | "Same words. Now shout." → huge, heavy, yellow ★ (hype). **The money moment: point at it.** "Same sentence, different feeling, and the captions knew." |
| 1:05–1:15 | **Next ▶** Card 4: hold *"nooooo"* | "Hold a word." → the word stretches wide |
| 1:15–1:25 | **Next ▶** Card 5: complain about something | → red ▲ (angry) |
| 1:25–1:40 | Turn the laptop: **Director's View** | "It compares every word to your own normal level, in decibels. A whisper is also detected because whispers have no vocal-cord vibration. The emotion model runs on this laptop; the caption text never leaves it." |
| 1:40–1:50 | Press **3** (force angry) while talking calmly | "The streamer stays in charge: a hotkey forces a mood for a bit." Press **0** to go back to auto. |
| 1:50–2:00 | | "Built for streamers, and Deaf and hard-of-hearing viewers finally get the tone too." |

If they have time for one more: Stop → **Export → After Effects** and say "Live on stream tonight, editable in After Effects tomorrow, with the loudest and most emotional moments already marked." *(Run the .jsx in After Effects yourself before judging; it hasn't been tested in AE yet.)*

### Coaching the judge
- If a whisper comes out "soft" instead of "whisper": "Even quieter, really breathy." Real whispers (no voice) are caught most reliably.
- If a shout comes out only "loud": "Louder, like you just won." Shout = about 8 dB above their normal.
- If calibration bar isn't full after card 1: have them say one more normal sentence.
- If something looks wrong: click **New judge** and restart the cards. It takes 10 seconds.

---

## Numbers you can say (from our own tests, be honest about the source)

- **Emotion:** on 20 streamer-style lines we didn't tune on, Loudtype gets the feeling right **18/20**; a standard positive/negative sentiment model gets **12/20**, mostly because it colors neutral lines like "let me check the map".
- **Same words, different voice:** "this is the best day ever" whispered → calm, shouted → hype; "I miss my old dog" → sad. 8/8 voice quadrant tests pass.
- **Loudness levels:** in a test clip with known whispers, quiet, loud and shouted words, Loudtype labels **48/51 words exactly** and all 51 within one level (synthetic voices, real ElevenLabs timing).

Reproduce: `node scripts/eval-emotion.mjs` and `node scripts/eval-volume.mjs`.

---

## Q&A prep

**"How does it know I'm loud? Everyone's mic is different."**
It learns your normal level from your first sentence, then measures every word in decibels against *you*. A shout is about 8 dB above your normal, on any mic. (Show Director's View: the bar and the thresholds.)

**"How do you detect a whisper?"**
Two signals: it's quieter than your normal, and it has no voicing. Whispers don't vibrate the vocal cords, so the audio has no pitch. That works even if the mic is close.

**"What if the emotion is wrong?"**
It only colors a line when it's confident; otherwise the line stays white. Size and weight always come straight from the voice. The streamer can force a mood with a hotkey.

**"What if someone else talks? It's loud in here."**
Your first sentence teaches it your voiceprint, on this laptop. Every line is compared to it in about 20 ms; anyone else's line is never captioned, even live. (Director's View: "last line: you ✓ 0.68".) Whispers have no voice to compare, so they're judged by loudness instead.

**"How does it understand stream slang?"**
The emotion model (GoEmotions, 28 emotions) runs on-device; we added a small stream-slang layer because the model reads "that was so sick" as illness.

**"Isn't the motion distracting?"**
Every word sits on one fixed baseline. Nothing moves up or down, shakes or rotates. The only motion is a short fade-in and a small pop on shouts.

**"Captions lag."**
Words appear as they're recognized (about a second). Sync mode (roadmap) tells the streamer the OBS delay to set so words land on the syllable.

**"Isn't this just captions?" / "CapCut does this."**
CapCut styles captions after editing by guessing from text. Loudtype is live, driven by how the voice actually sounded, and exports editable animation.

**"Privacy?"**
No accounts, nothing saved; the emotion model runs locally. Audio is streamed to ElevenLabs for speech-to-text only. *Don't claim zero retention unless your ElevenLabs account supports it: the current plan reports it isn't applied (enterprise/trial only).*

**"Why would anyone pay?"**
Streamers already pay for overlays and alert packs. Style packs are the product; highlight markers save editors time.

---

## Before judging: checklist

- [ ] Headset mic works; macOS input set to it
- [ ] Server running (`npm start`), model warmed up
- [ ] Overlay full screen on the judge-facing display
- [ ] Practiced the 2-minute script at least 3 times
- [ ] After Effects export opened in AE once
- [ ] Offline demo clip plays (Wi-Fi off test)
- [ ] Three customer-discovery quotes in the README (streamer, Deaf/HoH viewer, motion designer)
