videojs.registerPlugin("activeTranscript", function (options) {
  const player = this;
  const opts = options || {};
  const containerId = opts.containerId || "transcript";
  const activeClass = opts.activeClass || "active";
  const autoScroll = opts.autoScroll !== false;

  function findContainer() {
    return document.getElementById(containerId);
  }

  function pickTrack() {
    const tracks = player.textTracks ? Array.from(player.textTracks()) : [];

    // Prefer captions/subtitles; metadata is less consistently exposed
    const preferred = tracks.find(t => t.kind === "captions" || t.kind === "subtitles");
    return preferred || tracks[0] || null;
  }

  function waitForCues(track, cb) {
    let tries = 0;
    (function poll() {
      tries++;
      const cues = track && track.cues ? Array.from(track.cues) : [];
      if (cues.length) return cb(cues);
      if (tries > 80) return cb([]); // ~8 seconds
      setTimeout(poll, 100);
    })();
  }

  function render(container, cues) {
    container.innerHTML = "";
    const lines = [];

    cues.forEach((cue, idx) => {
      const el = document.createElement("div");
      el.className = "transcript-line";
      el.textContent = cue.text;

      el.addEventListener("click", () => {
        player.currentTime(cue.startTime + 0.01);
        player.play();
      });

      container.appendChild(el);
      lines.push(el);
    });

    function highlight() {
      const t = player.currentTime();
      let active = -1;

      for (let i = 0; i < cues.length; i++) {
        if (t >= cues[i].startTime && t < cues[i].endTime) { active = i; break; }
      }

      lines.forEach(l => l.classList.remove(activeClass));
      if (active >= 0 && lines[active]) {
        lines[active].classList.add(activeClass);
        if (autoScroll) lines[active].scrollIntoView({ block: "nearest" });
      }
    }

    player.on("timeupdate", highlight);
    highlight();
  } 

  player.ready(() => {
    // Container may be below player on the page
    const container = findContainer();
    if (!container) {
      console.warn("[activeTranscript] Missing transcript container:", containerId);
      return;
    }

    container.innerHTML = "Loading transcript…";

    const track = pickTrack();
    if (!track) {
      container.innerHTML = "No captions/subtitles track found on this video.";
      return;
    }

    // Ensure browser exposes cues
    track.mode = "hidden";

    // Some Brightcove setups populate cues only after playback starts
    player.one("play", () => {
      waitForCues(track, (cues) => {
        if (!cues.length) {
          container.innerHTML = "Captions exist, but transcript cues weren’t available to the plugin.";
          return;
        }
        render(container, cues);
      });
    });

    // If user already playing fast, still attempt
    waitForCues(track, (cues) => {
      if (cues.length) render(container, cues);
    });
  });
});
