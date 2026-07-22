# Score Frame Collector

Chrome MV3 extension for collecting timestamped score ROI samples from a YouTube watch tab and grouping unique score images locally.

Current scope:

- validates the active tab is a YouTube `watch` page
- starts capture from the extension action click
- asks the user to drag-select the score ROI on top of the YouTube video
- uses `chrome.tabCapture.getMediaStreamId()` and an offscreen document
- samples tab video frames every 1000ms
- crops only the selected score ROI in the offscreen document
- creates local fingerprints and clusters repeated score samples
- emits lightweight ROI identity debug metadata
- shows temporary ROI thumbnail previews in the options page
- does not persist raw full frames

The default path does not call Gemini, Claude, or any candidate judge. Legacy AI judge settings remain explicit-only in the options page for manual experiments; no `.env` key is bundled into the extension build. If you enter a Gemini key directly, Chrome asks for the Gemini host permission. If you use a proxy URL, Chrome asks for that proxy origin.

## Development

```sh
npm install
npm run verify
```

Load the generated `dist/` directory in `chrome://extensions` with Developer Mode enabled.

## Manual Smoke Test

1. Open `chrome://extensions`.
2. Load the generated `dist/` folder as an unpacked extension, or click reload after rebuilding.
3. Open a YouTube `watch` page with score notation visible.
4. Click the extension action once to start capture.
5. Drag the score area on the video overlay and click `Use this area`.
6. Open the extension options page.

The options page shows:

- latest session state and frame metadata
- recent temporary ROI thumbnail previews
- ROI identity decision: `same`, `maybe_same`, or `different`
- cluster counts, accepted counts, pending count, hash distances, projection similarity, and representative quality

Click the extension action again to stop capture.

## Current Detector Ceilings

- The sampling loop is intentionally lossy: if the previous analysis/debug send is still running, the next tick is counted as dropped instead of queued.
- The score identity model is local and heuristic. Tune the fingerprint thresholds when real video samples show false merges or false splits.
- Near the end of a video, a new `different` ROI sample is held until a consecutive score-like sample confirms it; unconfirmed or overlay-like end samples are excluded from PDF/PNG export.
