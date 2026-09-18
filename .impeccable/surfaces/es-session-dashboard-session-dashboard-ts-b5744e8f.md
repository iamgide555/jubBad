---
version: 1
slug: "es-session-dashboard-session-dashboard-ts-b5744e8f"
primary_target: "web/src/app/pages/session-dashboard/session-dashboard.ts"
related_targets: []
---

## Direction contract

THESIS: The dashboard as a real court on a bright, well-lit indoor space, not a chalkboard mock-up — refuses the retired paper-and-marker device in favor of equipment-grade material: real rounding, layered elevation, and a colored ring that carries state.

OWN-WORLD: Daylight Court — a shared light ground/surface (`--ground` #faf8f4, `--surface` #ffffff in light theme; both themes share one ink scale), a structural court-green (`--court` #1f6b3d) carrying the primary action, the live state, and navigation, and a reserved shuttle-orange (`--accent` #ff5a36) for "the host must act on this court right now." Court panels are flat rounded cards (`--radius-lg`, 22px) that lift and ring by elevation and color, never tilt or tape. Headings and court numbers are set in Bai Jamjuree; body and data in Anuphan — both with native Thai and Latin digit coverage. Games-played reads as small tally text, never a badge or pill.

STORY: The host glances at the board, sees which court is live (a green ring + lift) versus pending (an orange ring + one-shot pulse) versus idle (flat, quiet), taps a rounded chip to rest a player, taps a real-bordered ghost button to resync the queue. Every action reads as operating real equipment, not marking up a sheet.

FIRST VIEWPORT: Rounded roster chips across the top; a row of outline toolbar buttons with real 1.5px borders; a two-up grid of flat, rounded court cards below, each showing both teams and their tally with a state-colored ring; a waiting queue along the bottom reordered via FLIP animation.

FORM: Full implementation shipped across all 10 routes; session-dashboard and court-panel received the deepest pass (idle/pending/active/ended state choreography via elevation + ring, not the retired system's three static shadow recipes).

FINISH: Delivered and documented — see root DESIGN.md and .impeccable/design.json for the carbonized system this surface, and the rest of the app, now draws from.
