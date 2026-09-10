# App Privacy questionnaire — exact answers

App Store Connect → your app → App Privacy. Work through it in this order.

---

## 1. "Do you or your third-party partners collect data from this app?"

### **No**

Select **No, we do not collect data from this app**, then Publish.

That single answer produces the "Data Not Collected" label on the product page
and ends the questionnaire. Everything below is the justification, kept here so
whoever fills the form (or answers an App Review query) can back it up.

---

## Why "No" is the correct answer

Apple defines *collection* as transmitting data off the device. Orbital Rush
transmits nothing, because it has nowhere to transmit to.

| Category Apple asks about | In this app |
| --- | --- |
| Contact info | Not requested, not present. No account, no email, no sign-in. |
| Health & fitness | Not requested. |
| Financial info | Not requested. There are no in-app purchases and no payment code. |
| Location | Not requested. No location entitlement in the app. |
| Sensitive info | Not requested. |
| Contacts | Not requested. |
| User content | The app has no text input, no photos and no sharing of user content. The Share button hands a plain sentence to the system share sheet; the app never sees where it goes. |
| Browsing history | None. The app makes no web requests. |
| Search history | There is no search. |
| Identifiers | No IDFA, no IDFV read, no device ID, no user ID. The App Tracking Transparency prompt is never shown because nothing is tracked. |
| Purchases | No StoreKit code is linked. |
| Usage data | No analytics SDK of any kind. No product interaction, advertising or crash data leaves the device. |
| Diagnostics | No crash reporter, no performance SDK. |
| Other data | None. |

## What is stored on the device (and why it is not "collection")

One JSON blob under the key `orbital-rush/profile/v1`, written to the WebView's
local storage and mirrored to `UserDefaults` through the Capacitor Preferences
plugin:

```
bestScore, bestCombo, bestZone, energy, totalEnergy, runs, totalRings,
totalTimeMs, skin, ownedSkins, sfx, music, haptics, reducedFx,
seenTutorial, missionsDate, missions, streak, lastPlayDate, dailyRewardDate
```

It is the player's own progress, it stays on the device, and Settings → **Reset
progress** deletes it. Under Apple's definition, on-device-only storage that is
never transmitted is not collection, so it is not declared.

## Third-party SDKs

None. The dependency list is Capacitor's own runtime plus four first-party
Capacitor plugins (App, Haptics, Preferences, Splash Screen, Status Bar), none
of which collect or transmit data.

## Privacy manifest

`ios/App/App/PrivacyInfo.xcprivacy` is included in the target and declares:

* `NSPrivacyTracking` — `false`
* `NSPrivacyTrackingDomains` — empty
* `NSPrivacyCollectedDataTypes` — empty
* `NSPrivacyAccessedAPITypes` — `NSPrivacyAccessedAPICategoryUserDefaults`
  with reason **CA92.1** (access to app-owned defaults only)

That matches the questionnaire answer above; a mismatch between the two is a
common rejection reason, so keep them in sync if the app ever changes.

## Export compliance

`ITSAppUsesNonExemptEncryption` is set to `false` in `Info.plist`. The app uses
no encryption beyond what the OS provides (and makes no network connections at
all), so uploads will not stop to ask.
