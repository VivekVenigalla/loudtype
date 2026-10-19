# Loudtype: feature plan to win Hacklanta '26

Written 2026-10-10, mid-hackathon (event runs Oct 9–11). Kept outside the repo on purpose.
Sources: three research passes (competitors/DHH research, hackathon + sponsor prizes, far-field voice rejection), the team rubric ("Hacklanta '26 Project Selection Criteria.pdf"), and the current code (140 tests passing).

---

## 0. Where we stand

**Rubric score today: 192 / 225 = 85.3%. Final = 85.3 × 0.9 ≈ 77.** All three gates pass.

| Row (weight) | Now | Target | Points available |
|---|---|---|---|
| Local / community angle (2) | 2 | 5 | **+6** |
| Creative: output makes judges react (5) | 4 | 5 | **+5** |
| Sponsor relevance, Adobe (4) | 4 | 5 | **+4** |
| Judge can try it (3) | 4 | 5 | **+3** (far-voice fix) |
| Live demo loop (3) | 4 | 5 | **+3** (robust at venue noise, no stalls) |
| Judge industry match (3) | 3 | 4 | +3 (frame for Microsoft/AWS judges too: accessibility, on-device ML) |
| Survives follow-ups (2) | 4 | 5 | +2 (every teammate rehearses the "two levels deep" answers) |
| Business plausibility (2) | 4 | 5 | +2 (pricing + cost-per-hour slide line) |
| Sponsor tool use (1) | 3 | 5 | +2 (AE export proven, Scribe features used deeply) |
| **Ceiling** | | | **225 / 225** |

The one-line pitch the research supports:
> "Google proved people want captions that sound like the speaker. CHI research shows Deaf and hard-of-hearing viewers find flat captions dull. Nobody ships this live for creators. Loudtype does."

Key facts from research:
- Closest analogue: **Google Android Expressive Captions** (Dec 2024): live, audio-driven, but intensity is only ALL CAPS + "Amaaazing" lengthening + sound labels; phone-only, no overlay, no size/weight/color. YouTube added text emotion tags ("[joy]") to *recorded* uploads in Dec 2025.
- Every OBS caption tool (LocalVocal, Cloud Closed Captions, Stream Closed Captioner) is plain text. Every clip editor (Submagic, OpusClip, CapCut, Captions.app) styles from **text**, after the fact. **No live, voice-driven, variable-font caption overlay exists.**
- CHI 2023 (de Lacerda Pataca et al.) used loudness→weight, duration→spacing: nearly our mapping; DHH users called plain captions "dull". Fels 2005: hard-of-hearing viewers liked emotive captions, **Deaf viewers disliked them**. Hassan 2023: preferences vary per person. → expressiveness needs a dial.
- Caption Royale (CHI 2024, 39 DHH): readability and minimal distraction ranked top. → our "one baseline, no motion" rule is a selling point; say it.
- Hacklanta: $2,500 for 1st per main track. No published rubric. Zero Data brief: "no accounts, tracking, profiles, or stored personal info." Best Use of ElevenLabs = MLH side quest (earbuds).
- Adobe's past MLH winners (e.g., Accessify, UGAHacks) won on **accessibility + design craft**. Firefly API is enterprise-only (skip). Adobe Fonts can't be self-hosted (breaks COEP + zero-data; skip).

---

## 1. Fix first: far-away voices get captioned (item 1)

> **Status 2026-10-10: DONE on branch `far-voice`** (commit f4844bf): voiceprints (layer D) + whisper-aware gate + live-word filtering. Layer B ruled out: Scribe rejects `filter_background_audio` together with timestamps; `vad_threshold` 0.6 didn't help. Verified offline 8/8 (close + Mac mic) and in the browser via Scribe (6/6 main lines kept, 3/3 strangers dropped). Still to do: test with two real people on the MacBook mic.

**Diagnosis (from the code):**
1. **Partials bypass the filter.** In single-speaker mode `transcript.js` `emitPartial()` shows every partial word; `styleLive()` only sets background words to "normal". Far voices flash on screen, then vanish at commit.
2. **Far speech can pass as a whisper.** `prosody.background()` only judges words with voiced ≥ 50%. Reverberant far speech has weak periodicity → reads unvoiced → treated as a whisper → always kept (small captions).
3. **Gate is near-useless on the MacBook mic.** Normal is only ~12 dB over room noise, so `max(noise+6, normal−18)` ≈ noise+6 and far talkers pass.

**Layered plan (lowest latency first):**

| Layer | What | Added latency | Effort | Risk |
|---|---|---|---|---|
| A. Close the three gaps | (1) hold a partial word back until its live audio window matches the main speaker (or hide partial words whose window is background; show them once confirmed). (2) A whisper must be *near*: unvoiced words count as whispers only if their level is within the whisper band of normal AND above the gate; quiet unvoiced audio far under normal is background. (3) Raise the gate floor on low-SNR mics and warn "use a headset" when normal − noise < 20 dB. | 0 ms (partials: ≤ one partial burst) | 2–3 h incl. tests | Real whispers on a weak mic could be dropped; tune with ballroom tests + a mic report |
| B. Scribe settings | Add `vad_threshold` (default 0.4 → try 0.6) and `filter_background_audio=true` (documented, undescribed). A/B with `node scripts/eval-ballroom.mjs` (uses ~1 min quota each run). | 0 ms | 30 min | Undocumented behavior; may also cut whispers. Keep only if the eval improves |
| C. Nearness score | Per frame in the worklet: low-frequency share (100–300 Hz vs 1–4 kHz), onset sharpness / 4 Hz envelope modulation, LP-residual kurtosis. Calibrate per speaker; add as a soft vote in `background()`. | 0 ms (≈1k ops per 33 ms frame) | 4–6 h | Noisy on omni mics; never a hard gate |
| D. Voiceprint (speaker verification) | `onnx-community/wespeaker-voxceleb-resnet34-LM` (CC-BY-4.0, int8 6.7 MB / fp16 13 MB). The vendored transformers.js 4.3.1 already contains `WeSpeakerFeatureExtractor` + `WeSpeakerResNetModel` (verified locally). Enroll from calibration audio (≥ 8–10 s); embed each committed line's voiced audio (≥ 1 s, pad short lines with the previous 1.5 s); cosine > ~0.5 keep, < ~0.3 drop, between → acoustic filter. Whispers exempt. Multi-speaker: one embedding per profile. | ~30–80 ms per committed line (estimate, not measured); partials unaffected | 6–8 h | Short lines unreliable; competes with emotion model for 4 threads (run in sequence); needs a one-time model download (ask first) |
| E. Hardware | Headset/boom mic for the judge: ~30 dB wearer advantage vs ~6–12 dB on the MacBook mic. | — | — | Already in DEMO.md; enforce with the SNR warning from A |

**Recommendation for the hackathon:** A + B now (cheap, measurable), E at the table. D is the "how did you build that in 36 hours" story but only if A+B leave real leaks; C after the event.
Only the gate (A3) keeps far audio from reaching ElevenLabs at all; B–D filter after the fact. Say that honestly for Zero Data.

---

## 2. Features, ranked by points per hour

Hours are rough for one person familiar with the code. "Rows" = rubric rows raised.

### Tier 1: do before judging (highest points per hour)

1. **Customer-discovery quotes + Atlanta clip** (Rows: Local +6, Follow-ups) · 2 h, no code.
   Get three quotes on the floor today: a streamer, a Deaf/HoH person (or someone who captions for them), a motion designer/editor. Record a real `replay/demo.json` of an Atlanta voice (freestyle verse, a hype moment) with Stop → Save last session. Questions in section 4.
2. **Far-voice fix layers A + B** (Rows: Judge can try +3, Demo loop +3). See section 1. 3 h.
3. **Run the After Effects export in AE once and screen-record it** (Rows: Sponsor relevance +4, Sponsor tool +1). 1 h. Show "live tonight, editable in AE tomorrow, highlights already marked." Fix ES3 issues if any.
4. **Visual design pass on the overlay + one more pack** (Rows: Creative +5). 3–4 h. Arcade (bold, saturated, chunky outline) or Ink (serif, paper). Font/palette/outline only; the type grammar never changes. Add `DEFAULT_PACK`.
5. **Stream-safe mode via Scribe `entity_detection` (`offensive_language`)** (Rows: Sponsor tool, ElevenLabs prize, Business). 2 h. Swear words become a symbol burst (#@%!) at the same size, weight and color. Uses a real Scribe feature instead of a word list, and closes the unimplemented `STREAM_SAFE` flag.
6. **"Before / after" split screen in the demo** (Rows: Wow, Creative). 1 h. Left: plain white captions (what Twitch shows). Right: Loudtype. Same judge voice. The contrast is the wow moment, in one glance.
7. **Expressiveness dial (0 = plain captions → 100 = full)** (Rows: Track-specific, Follow-ups, Business). 1–2 h. Directly answers the Deaf-vs-HoH finding (Fels 2005, Hassan 2023). Great Q&A answer: "Deaf viewers in research disliked emotive captions, so it's a dial, not a gimmick."
8. **Zero-Data proof screen** (Rows: Zero Data challenge, Follow-ups). 30 min. Show DevTools Network: only localhost + api.elevenlabs.io; show COEP headers blocking third parties. Say honestly that zero-retention STT needs an enterprise plan; the code path is there (`enable_logging=false`).

### Tier 2: if time remains (strong add-ons)

9. **Sound and vocal-burst labels** ([laughs], [sighs], [applause], [whispering]) on the same baseline, sized by loudness. Google ships these; nobody sizes them. Detect laughter/claps from our own frames (bursty, unvoiced) or Scribe audio events if realtime emits them (batch does; realtime not documented). 3–4 h.
10. **Scribe `keyterms`** for the streamer's name, game terms and Atlanta slang (ATL, "Decatur", "Bankhead"), editable in the control panel. 1 h. Visible ElevenLabs depth + local angle.
11. **Sync mode / latency readout**: show measured caption lag (learned partial lag + commit time) and the OBS delay to set. 2 h. Answers "captions lag" before a judge asks.
12. **Speaker colors/brackets for multi-speaker mode** using the BBC caption palette (white, yellow, cyan, green), name tags. 2 h. Research: DHH preference depends on speaker count.
13. **"Moments" reel**: after Stop, auto-cut the top 3 loudest/most emotional lines into a ready-to-post vertical clip of animated captions (canvas → WebM via MediaRecorder; saved only on click). 4–6 h. Hits the clip-editor market with *voice-driven* styling nobody has.
14. **Styled .ass export** (per-word size/weight/color tags) for CapCut/Submagic/Premiere workflows. 2 h. Clip tools are text-only today; we hand them the prosody.
15. **Voiceprint layer D** (see section 1). 6–8 h. Big "how did you build that" moment if shown in Director's View ("Voice match 0.82 ✓ / stranger 0.21 ✗").

### Tier 3: stretch or pitch-only (mention in "what's next")

16. **Music / freestyle mode**: beat-synced fade-ins, held notes stretch, rhyme words highlighted (μCap and FAME, CHI 2026, show demand). Perfect Atlanta hook (hip-hop).
17. **VTuber pack + emotion feed** to the avatar (VTube Studio API) so the avatar's expression follows the caption emotion.
18. **Twitch CC passthrough** so viewers can toggle plain captions on/off while the overlay stays expressive.
19. **Haptic captions**: per-word wrist/phone vibration scaled to loudness (CHI work showed higher engagement with haptics). Phone page over the local relay.
20. **Live theatre/comedy/church mode**: big-screen captions for venues (about 1% of UK performances are captioned; Stagetext).
21. **Classroom mode**: teacher emphasis visible to DHH students.
22. **Translation that keeps the voice**: translate the line, keep each word's level by alignment (Scribe language detection + local MT). Hard; pitch only.
23. **Voice-chat teammates**: caption Discord/game voice chat (a second audio input, its own profile). Existing Twitch CC tools only hear the streamer.
24. **Adobe Express add-on** that imports the styled captions as editable text layers (MLH's Adobe category is Express add-ons). Only if a teammate has done Express add-ons before (risk: new tool → P(finish) 0.7).
25. **ElevenLabs Sound Effects "crowd" stinger** on a shout line (generated once, cached locally, played only in demo mode). Fun but risks feeling bolted-on; winners make ElevenLabs core, not decorative.

### Do NOT do
- Firefly API (enterprise-only access), Adobe Fonts CDN (breaks COEP and the zero-data claim), any account/login, analytics, baseline motion/rotation/shake (breaks the design rules and the DHH readability findings).

---

## 3. Suggested schedule for the remaining hours

| Block | Work | Who |
|---|---|---|
| Now → +3 h | Far-voice fix A + B, tests, ballroom eval | 1 dev |
| Now → +2 h | Customer-discovery quotes on the floor; record Atlanta clip | 1 person |
| +2 → +5 h | Overlay design pass + second pack; before/after split view | 1 dev / designer |
| +3 → +5 h | Stream-safe via Scribe entity detection; expressiveness dial | 1 dev |
| +5 → +6 h | Run AE export in After Effects, screen-record | anyone with AE |
| +6 h → judging | Freeze features. Rehearse the 2-minute script 3×, each teammate answers "how does it work?" two levels deep. Venue-noise test with the headset. Offline replay test with Wi-Fi off. |

---

## 4. Steve-Blank-style questions for Loudtype

**Streamers**
1. "Walk me through the last time a viewer missed what you were saying. What happened?"
2. "Have you ever tried captions on stream? What made you keep or turn them off?"
3. "What do you do today when you want a moment to look as loud as it felt? (edits, emotes, alerts?)"
4. "What do you pay for overlays/alerts now, and what made you buy the last one?"
5. "If you could wave a magic wand over your stream's text on screen, what would change?"

**Deaf / hard-of-hearing viewers (or interpreters/captioners)**
1. "Tell me about the last video or stream where captions lost the joke or the tone."
2. "What do you do now to figure out if someone is yelling or joking?"
3. "When captions try to be fancy, what annoys you?" (listen for motion/distraction)
4. "Would you want this always on, or a dial you control?"

**Adobe people / motion designers / editors**
1. "How long does it take you to animate captions for a clip today? Which part is tedious?"
2. "What do your users go do in another app (CapCut, Submagic) and drag back into Premiere/AE?"
3. "When you see another AI caption tool, what makes you roll your eyes?"
4. "Would timing + loudness data per word, already in AE, save you time? What would you do with it?"

Close every conversation: "What should I have asked you that I didn't?" · "Who else here should I talk to?"
Good signal: a specific story, mild annoyance, or a workaround they built. Three people naming the same pain = build it.

---

## 5. Q&A lines to add to DEMO.md

- "Isn't Google already doing this?" → "Android's Expressive Captions switch to ALL CAPS on your phone. We use size, weight, width and color, live, as an OBS overlay any streamer can add, and we export it to After Effects."
- "Doesn't motion hurt readability?" → "Research with 39 DHH viewers ranked readability and minimal distraction highest. That's why every word sits on one baseline: no bouncing, no shaking."
- "Deaf viewers might not want this." → "Right, research found Deaf viewers disliked emotive captions while hard-of-hearing viewers liked them. So it's a dial."
- "What if someone else talks?" → (after the fix) "The gate keeps quiet audio from ever reaching speech-to-text; the filter drops voices that aren't yours by level, pitch [and voiceprint]."
