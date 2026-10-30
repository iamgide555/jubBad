# Bundled Tesseract language data

Files: `eng.traineddata`, `tha.traineddata` (uncompressed, `tessdata_fast` variant).

- Source: https://github.com/tesseract-ocr/tessdata_fast
  (downloaded from `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{eng,tha}.traineddata`)
- Licence: Apache-2.0
- Downloaded: 2026-10-30

Used by the slip OCR (`server/src/sessions/slips/slip-ocr.ts`, constant `TESSDATA_DIR`).
Bundled so the server never fetches language data from a CDN at runtime.

## Where the code expects this folder

`TESSDATA_DIR` must resolve to this folder from both layouts:

- source / vitest / `nest start --watch`: `server/src/sessions/slips/` -> `server/assets/tessdata`
  (three levels up, then `assets/tessdata`)
- production: code is at `/app/dist/server/src/sessions/slips/`, and the Dockerfile
  copies `server/assets` to `/app/assets` (five levels up, then `assets/tessdata`)

`nest build` does not copy `assets/` into `dist`; the Dockerfile `COPY` is what puts it at `/app/assets`.
