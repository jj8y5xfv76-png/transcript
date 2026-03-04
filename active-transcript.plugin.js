(function () {
  function waitForVideoJS(cb) {
    if (window.videojs && typeof window.videojs.getPlugin === "function") return cb(window.videojs);
    setTimeout(() => waitForVideoJS(cb), 50);
  }

  function parseVtt(vttText) {
    const lines = vttText.replace(/\r/g, "").split("\n");
    const cues = [];
    let i = 0;

    function parseTime(t) {
      const parts = t.split(":");
      let h = 0, m = 0, s = 0;
      if (parts.length === 3) {
        h = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10);
        s = parseFloat(parts[2]);
      } else {
        m = parseInt(parts[0], 10);
        s = parseFloat(parts[1]);
      }
      return h * 3600 + m * 60 + s;
    }

    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line || line === "WEBVTT") { i++; continue; }

      let timeLine = line;
      if (i + 1 < lines.length && lines[i + 1].includes("-->") && !line.includes("-->")) {
        i++;
        timeLine = lines[i].trim();
      }
      if (!timeLine.includes("-->")) { i++; continue; }

      const [startRaw, endRaw] = timeLine.split("-->").map(s => s.trim().split(" ")[0]);
      const start = parseTime(startRaw);
      const end = parseTime(endRaw);

      i++;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }

      const text = textLines.join("\n").replace(/<[^>]+>/g, "").trim();
      if (text) cues.push({ startTime: start, endTime: end, text });

      i++; // blank
    }
    return cues;
  }

  waitForVideoJS(function (videojs) {
    const Plugin = videojs.getPlugin("plugin");

    class ActiveTranscript extends Plugin {
      constructor(player, options) {
        super(player, options || {});
        this.player = player;

        const opts = options || {};
        this.containerId = opts.containerId || "transcript";
        this.language = opts.language || null;
        this.trackKind = opts.trackKind || null; // "captions" | "subtitles" | "metadata"
        this.activeClass = opts.activeClass || "active";
        this.autoScroll = opts.autoScroll !== false;

        this.container = document.getElementById(this.containerId);
        this.lines = [];
        this.cues = [];
        this.activeIndex = -1;

        player.ready(() => {
          player.one("loadedmetadata", () => this.init());
          player.on("timeupdate", () => this.onTimeUpdate());
        });
      }

      say(msg) {
        if (!this.container) return;
        this.container.innerHTML = `<div style="font-size:13px; padding:8px;">${msg}</div>`;
      }

      init() {
        if (!this.container) {
          console.warn("[ActiveTranscript] Missing container:", this.containerId);
          return;
        }

        // Critical: if you're opening via file://, fetch to Brightcove text tracks often fails.
        this.say("Loading transcript…");

        if (!this.player.catalog || !this.player.catalog.getVideo) {
          this.say("❌ Brightcove catalog API not available on this player (player.catalog.getVideo missing).");
          return;
        }

        const videoId = this.player.mediainfo && this.player.mediainfo.id ? this.player.mediainfo.id : null;
        if (!videoId) {
          this.say("❌ Couldn't determine video id (player.mediainfo.id missing).");
          return;
        }

        this.player.catalog.getVideo(videoId, (err, video) => {
          if (err) {
            console.error(err);
            this.say("❌ Error loading video metadata via catalog.getVideo().");
            return;
          }

          const tracks = (video && video.text_tracks) ? video.text_tracks : [];
          if (!tracks.length) {
            this.say("❌ No text_tracks found in video metadata (video.text_tracks empty).");
            return;
          }

          // Pick a track
          const pick = () => {
            if (this.trackKind) {
              const exact = tracks.find(t => t.kind === this.trackKind && (!this.language || t.srclang === this.language));
              if (exact) return exact;
            }
            const caps = tracks.find(t => (t.kind === "captions" || t.kind === "subtitles") && (!this.language || t.srclang === this.language));
            if (caps) return caps;
            if (this.language) {
              const langAny = tracks.find(t => t.srclang === this.language);
              if (langAny) return langAny;
            }
            return tracks[0];
          };

          const chosen = pick();
          const vttUrl = chosen && (chosen.src || chosen.src_url);

          // Show what we picked (so we know it's real)
          const trackSummary = tracks.map(t => `${t.kind}:${t.srclang || ""}:${t.label || ""}`).join(", ");
          if (!vttUrl) {
            this.say(`❌ Found tracks (${trackSummary}) but no VTT URL on the chosen track.`);
            return;
          }

          this.say(`✅ Found tracks: ${trackSummary}<br>➡️ Fetching VTT…`);

          fetch(vttUrl)
            .then(r => {
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              return r.text();
            })
            .then(text => {
              this.cues = parseVtt(text);
              if (!this.cues.length) {
                this.say("❌ VTT fetched, but no cues parsed.");
                return;
              }
              this.render(this.cues);
              this.say(""); // clear message
            })
            .catch(e => {
              console.error(e);
              this.say("❌ Couldn't fetch the VTT file. This is usually CORS (common when opening demo via file://).");
            });
        });
      }

      render(cues) {
        this.container.innerHTML = "";
        this.lines = [];
        this.activeIndex = -1;

        cues.forEach((cue, idx) => {
          const line = document.createElement("div");
          line.className = "transcript-line";
          line.dataset.index = String(idx);
          line.dataset.start = String(cue.startTime);
          line.dataset.end = String(cue.endTime);
          line.textContent = cue.text;

          line.addEventListener("click", () => {
            this.player.currentTime(cue.startTime + 0.01);
            this.player.play();
          });

          this.container.appendChild(line);
          this.lines.push(line);
        });
      }

      onTimeUpdate() {
        if (!this.cues.length || !this.lines.length) return;

        const t = this.player.currentTime();
        let newIndex = -1;

        for (let i = 0; i < this.cues.length; i++) {
          if (t >= this.cues[i].startTime && t < this.cues[i].endTime) {
            newIndex = i;
            break;
          }
        }

        if (newIndex === this.activeIndex) return;

        if (this.activeIndex >= 0 && this.lines[this.activeIndex]) {
          this.lines[this.activeIndex].classList.remove(this.activeClass);
        }

        this.activeIndex = newIndex;

        if (newIndex >= 0 && this.lines[newIndex]) {
          const el = this.lines[newIndex];
          el.classList.add(this.activeClass);
          if (this.autoScroll) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }

    videojs.registerPlugin("activeTranscript", ActiveTranscript);
  });
})();