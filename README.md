# VWM Portal Lab 01: Six Worlds

A minimal IWSDK/WebXR interoperability test for the Virtual Worlds Museum™.

## Six destination portals

1. Arrival Space — https://live.arrival.space/virtualworldsmuseum
2. Horizon Worlds — https://horizon.meta.com/world/478207822044529/?locale=en_US
3. Hyperfy — https://hyperfy.io/virtualworldsmuseum/~luwj
4. RP1 — https://enter.rp1.com/?start_cid=104&lat=2.009970127790&lon=2.009992411959&rad=6371000
5. VIVERSE — https://www.viverse.com/HuoQZQX
6. Frame — https://framevr.io/virtualworldsmuseum

## What this test does

- Runs as a WebXR world on Meta Quest through the Quest browser.
- Uses IWSDK 0.5.x manifest-first project configuration and locomotion.
- Generates six oval portal structures entirely in code, with no external 3D assets: each portal has a glowing sci-fi ring, an animated plasma shader interior, and a museum placard.
- The room is a circular Star Trek style holodeck: yellow grid on black walls, floor, and ceiling, with a central dais carrying the Virtual Worlds Museum emblem.
- Detects when the viewer's head enters a portal opening.
- Exits the current WebXR session and navigates the same browser tab to the selected destination.

This first test proves destination handoff. Each destination platform controls what happens after the browser arrives there, including whether it offers WebXR directly or hands off to another application.

## GitHub Pages deployment

The repository name is expected to be exactly:

`vwm-portal-lab`

That name is already configured in `vite.config.ts` as the Vite base path.

1. Create a **public** repository named `vwm-portal-lab` under your GitHub account.
2. Upload all files and folders from this project, including `.github`.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment → Source**, choose **GitHub Actions**.
5. Open the **Actions** tab. The workflow named `Deploy VWM Portal Lab to GitHub Pages` should run automatically.
6. After a successful deployment, the site should be:

`https://KEYFRAME-SEHU.github.io/vwm-portal-lab/`

## Quest 3 test

1. Open Meta Quest Browser.
2. Go to `https://KEYFRAME-SEHU.github.io/vwm-portal-lab/`.
3. Select **ENTER VR**.
4. Use the left thumbstick to move and the right thumbstick to turn.
5. Walk into a portal.
6. Record what each destination does after the handoff.

## Updating portal URLs later

Open `src/index.ts` and edit only the `PORTALS` list near the top. Each portal has a `name`, `shortName`, `url`, and `color`.
