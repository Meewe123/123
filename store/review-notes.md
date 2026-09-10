# App Review notes

Paste the block below into **App Review Information → Notes** in App Store
Connect. Keep it short: reviewers read hundreds of these a day.

---

```
Orbital Rush is a single-player arcade game. No sign-in is required, so no
demo account is needed.

How to play: tap anywhere on the screen to reverse the direction your spark
orbits in. Slip through the gap in each incoming ring. Orbs inside the gaps
raise a multiplier; ones further from the safe line are worth more. The first
run shows four one-line hints as the mechanics come up; there is no tutorial
to sit through.

Notes for review:
- The app makes no network requests. It works fully offline, including in
  airplane mode.
- There are no ads and no third-party SDKs.
- Two cosmetic items are marked PREMIUM. This build ships no billing bridge,
  so tapping them says purchases are unavailable — nothing is charged and no
  purchase is simulated. Everything else is earned by playing.
- The leaderboard is the player's own history on their own device. The UI
  labels it "YOUR RECORDS" and never implies a global board.
- The Daily Run seed is derived from the calendar date on the device; no
  server is contacted.
- No data is collected. The only stored data is the player's own progress,
  kept on the device and erasable from Settings > Reset progress.
- All audio is synthesised at runtime; the app ships no media files.
- The Share button uses the standard system share sheet and sends only a short
  score sentence.
- Haptics can be turned off in Settings, along with music, sound effects, and
  a reduced-effects mode for players sensitive to motion.
```

---

## Pre-submission checklist

- [ ] `npm run verify` passes (icons regenerate, 65 unit tests, 54 e2e checks, 11 bundle checks).
- [ ] `npx cap sync ios` run after the last change to `www/`.
- [ ] Bundle ID in Xcode matches the one registered on developer.apple.com.
- [ ] `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` bumped.
- [ ] `CACHE` bumped in `www/sw.js` if the web build is also deployed.
- [ ] Support URL and Privacy Policy URL are live and load without a login.
- [ ] Screenshots uploaded for 6.9" and 6.5" (and 13" iPad if iPad is enabled).
- [ ] Age rating questionnaire completed — every answer is "None"; result 4+.
- [ ] App Privacy set to "Data Not Collected" (see `app-privacy.md`).
- [ ] Tested on a real device: audio starts on first tap, haptics fire, the
      status bar stays hidden, and the notch/home-indicator safe areas are
      respected in both orientations.

## Common rejection risks, and why they do not apply here

| Guideline | Risk | Status |
| --- | --- | --- |
| 2.1 App Completeness | Crashes, placeholder content | Full game, no placeholders; automated run covers every screen |
| 2.3.1 Hidden features | Undocumented functionality | None; `demo` is a test-only flag on the game object, not a hidden mode |
| 4.2 Minimum Functionality | "Too simple" / repackaged web page | Native project with real progression, offline play and system integration (haptics, share sheet, safe areas) |
| 5.1.1 Data Collection | Undeclared data use | Nothing collected; privacy manifest matches the questionnaire |
| 5.1.2 Data Use | Tracking without ATT | No tracking, no ATT prompt needed |
| 3.1.1 In-App Purchase | Selling outside IAP | Premium cosmetics route through the platform's own billing; with no bridge present they are refused, never sold another way |
