# Badminton AI Tracking — Future Build Research

- **Recorded:** 2026-10-30.
- **Intent:** Save research for a future badminton player/shuttle tracking project, including live camera analysis.
- **Status:** Research notes, not an approved implementation specification. Repository documentation was reviewed; no models or pipelines were run locally.

---

## Recommended Starting Point

- **Investigate RallyLive first:** It builds on Good-Badminton and adds live camera/stream input, tracking overlays, and movement statistics.
- **Validate before committing:** Test with footage from the intended venue and actual target hardware. Published FPS figures are author-reported, not locally verified performance.
- **Doubles is an open requirement:** JubBad supports casual doubles groups, but RallyLive describes upper-court/lower-court player assignment. Reliable tracking of four players and identity through crossings still needs proof.

---

## Repository Shortlist

| Repository | Documented capabilities | Future use |
|---|---|---|
| [Good-Badminton](https://github.com/yo-WASSUP/Good-Badminton) | Original AI badminton analysis project; upstream basis of RallyLive's offline pipeline | Understand the starting project |
| [RallyLive](https://github.com/JWM0203/RallyLive) | Live player pose, shuttle tracking, court mapping, movement stats, and overlays | First candidate for live analysis |
| [SoloShuttlePose](https://github.com/sunwuzhou03/SoloShuttlePose) | Singles player pose, court/net detection, shuttle trajectory, hit detection, and rally clipping | Pose and singles analysis reference |
| [Badminton-Tracker](https://github.com/m11ahmed/Badminton-Tracker) | Recorded-video player/shuttle tracking, court coordinates, movement estimates, heatmaps, and Streamlit review | Movement analytics reference; doubles validation is limited |
| [Badminton-VisionAI](https://github.com/amramer/Badminton-VisionAI) | YOLO/ByteTrack player tracking, TrackNet shuttle tracking, court projection, shot classification, and dashboard | Integrated analysis application reference |
| [BadmintonAI / COURTSIDE](https://github.com/jayclim/BadmintonAI) | Broadcast player/shuttle tracking, hit detection, shot classification, scoreboard reading, rally segmentation, and scouting dashboard | Match analytics and reporting reference |
| [TrackNetV3](https://github.com/qaz812345/TrackNetV3) | Shuttle trajectory detection and repair, pretrained checkpoint links, and video inference scripts | Shuttle tracking component |
| [MonoTrack](https://github.com/jhwang7628/monotrack) | Shuttle trajectory reconstruction from single-camera badminton video | Trajectory research reference |
| [CoachAI-Projects](https://github.com/wywyWang/CoachAI-Projects) | Badminton research, ShuttleSet annotations, and stroke forecasting work | Datasets and tactical analysis |

- **More discovery:** [awesome-badminton](https://github.com/Archong-2003/awesome-badminton) collects related tracking, pose, match analysis, and dataset projects.
- **Evidence boundary:** Capabilities above describe repository documentation, not independently confirmed correctness or production readiness.

---

## Real-Time Support

### RallyLive

- **Live inputs:** Local camera, browser webcam, OBS Virtual Camera, and RTSP/RTMP/UDP streams.
- **Live output:** Player skeletons, shuttle trails, court positions, speed/distance estimates, and rally counts.
- **Reported performance:** 30+ FPS on GPU. Actual performance depends on hardware, resolution, selected models, and display overhead; this does not establish end-to-end camera latency.
- **Recommended hardware:** GPU with 6GB+ VRAM, 16GB+ system RAM, and SSD storage. CPU execution is supported but documented as much slower.
- **Software:** Python 3.8+, FFmpeg, model weights, and optional Gradio WebUI. Default dependencies use CPU runtimes; GPU setup is a separate step.
- **Experimental areas:** Hit-point analysis and stroke statistics remain under iteration.
- **Source:** [RallyLive English documentation](https://github.com/JWM0203/RallyLive/blob/main/README_EN.md).

### Other Candidates

| Candidate | What the documentation establishes |
|---|---|
| **TrackNetV3** | Reports 25.11 FPS on its benchmark. Supplied inference workflow uses video files; live capture would need adaptation. It tracks the shuttle, not players. |
| **Badminton-Tracker** | Recorded-video workflow. Documentation says CPU processing can take several minutes for a short rally. |
| **Other shortlisted repositories** | Useful references, but live camera support and sustained real-time performance were not established in this research. |

- **Interpretation:** Model FPS, full-pipeline FPS, and camera-to-screen latency are separate measurements. Benchmark all three before promising real-time behavior.

---

## Suggested Future Evaluation Order

1. **Choose the target:** Decide whether the first goal is two-player tracking, four-player doubles tracking, shuttle tracking, or all three. Record target device and camera source.
2. **Reproduce an example:** Run RallyLive's documented setup with its sample input. Confirm model weights are available and GPU acceleration actually works.
3. **Test venue footage:** Use a fixed view of the complete court. Include player crossings, occlusions, neighboring courts, difficult lighting, and shuttle motion blur.
4. **Test live capture:** Connect the intended camera. Measure sustained FPS, camera-to-screen delay, dropped frames, reconnect behavior, and memory use over a full match.
5. **Check measurement quality:** Compare player positions and identity changes against manual review. Evaluate shuttle tracking separately from player tracking.
6. **Choose the build approach:** Extend RallyLive if it passes; otherwise assess reusable tracking components before building a new pipeline.
7. **Consider JubBad integration later:** Explore linking reviewed results to a court/session/match only after tracking works. Define identity mapping, result storage, and review controls before changing the app.

- **Scope boundary:** These are evaluation suggestions, not approved product commitments. No changes to JubBad's current match flow or live-scoreboard scope are proposed here.

---

## Questions to Resolve Before Building

- **Playing format:** Singles, doubles, or both? Must identities remain stable after players switch court sides?
- **Hardware:** Venue PC with NVIDIA GPU, Mac, or another device? What resolution and frame rate can the camera provide?
- **Deployment:** Local venue processing or remote processing? How will the camera reach the inference machine?
- **Success criteria:** What delay, tracking error, and identity-switch rate are acceptable for the intended use?
- **Shuttle measurements:** Image motion alone does not establish accurate shuttle speed in km/h or reliable line calls. Validate any such feature separately.
- **Reuse terms:** Check code, dependency, model-weight, and dataset licenses separately before redistribution or hosted use. A repository license does not automatically cover every downloaded asset.
- **Recording policy:** Decide access, retention, deletion, and whether raw video needs to leave the venue.

---

## Resume This Research

- **Next task:** Evaluate RallyLive on target hardware and representative doubles footage; report observed FPS, latency, identity failures, and shuttle tracking failures before selecting an implementation approach.
- **Recheck upstream:** Revisit repository activity, installation instructions, model downloads, and licenses when development begins; these notes capture documentation reviewed on 2026-10-30.
