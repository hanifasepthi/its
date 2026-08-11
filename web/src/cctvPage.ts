import "./cctvPage.css";

type FrameEvidence = { brightness: number; dominant: string; capturedAt: number; note: string };

const feeds = [
  ["Bundaran HI", "Jakarta Pusat", "#f97316", "LIVE"], ["Simpang Lima", "Semarang", "#22c55e", "LIVE"],
  ["Jembatan Ampera", "Palembang", "#38bdf8", "LIVE"], ["Tugu Jogja", "Yogyakarta", "#a78bfa", "LIVE"],
  ["Simpang Dago", "Bandung", "#06b6d4", "LIVE"], ["Pantai Losari", "Makassar", "#f59e0b", "VERIFIKASI"],
] as const;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function card([name, city, color, status]: typeof feeds[number], index: number): string {
  return `<button class="cctv-card" type="button" data-feed="${index}" style="--feed:${color}">
    <span class="cctv-card-visual"><span class="cctv-road"></span><em>${status}</em></span>
    <strong>${name}</strong><small>${city} · sumber publik</small>
  </button>`;
}

export function renderCctvPage(root: HTMLElement): void {
  document.title = "CCTV Indonesia | ITS Maps";
  root.innerHTML = `<main class="cctv-page">
    <header class="cctv-header"><a href="/" aria-label="Kembali ke peta">‹</a><strong>◉ CCTV Indonesia</strong><label><span>⌕</span><input id="cctv-search" placeholder="Cari lokasi atau kamera…"></label><button id="cctv-ai-open">✦ Tanya AI</button></header>
    <section class="cctv-focus">
      <div class="cctv-player-shell" id="cctv-player-shell">
        <div class="cctv-ambient" id="cctv-ambient"></div>
        <div class="cctv-stage" id="cctv-stage">
          <video id="cctv-video" playsinline controls></video>
          <canvas id="cctv-placeholder" width="960" height="540" aria-label="Preview kamera simulasi"></canvas>
          <div class="cctv-overlay"><span><i></i> LIVE</span><div><strong id="cctv-title">Bundaran HI</strong><small id="cctv-city">Jakarta Pusat</small></div></div>
          <div class="cctv-actions"><label class="cctv-upload">＋ Sumber video<input id="cctv-file" type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.avi" hidden></label><button id="cctv-chat">✦ Tanya AI</button><button id="cctv-fullscreen">⛶ Layar penuh</button></div>
        </div>
        <div class="cctv-trust"><span><b>✓ Sumber terverifikasi</b><small>Hanya katalog dengan asal dan lisensi yang dapat diaudit.</small></span><span><b>◎ Target katalog 100.000</b><small>Target ingest nasional—bukan jumlah kamera aktif saat ini.</small></span></div>
      </div>
      <aside class="cctv-ai" id="cctv-ai"><header><strong>✦ Tanya AI</strong><button id="cctv-ai-close" aria-label="Tutup">×</button></header><form id="cctv-ai-form"><textarea id="cctv-question" placeholder="Tanyakan kondisi, objek, atau prediksi berbasis frame…"></textarea><button>Kirim</button></form><div class="cctv-analysis"><h2>Analisis frame terbaru</h2><div id="cctv-evidence"><span class="cctv-spinner"></span> Menunggu frame…</div></div><div id="cctv-answer" class="cctv-answer">Jawaban dibatasi pada evidence frame yang tersedia. Sistem ini tidak mengklaim belajar otomatis dari video.</div></aside>
    </section>
    <section class="cctv-rail"><div><h2>Rekomendasi untuk Anda</h2><span>Geser di mobile · scroll di desktop</span></div><div id="cctv-feed-list" class="cctv-feed-list">${feeds.map(card).join("")}</div></section>
    <section class="cctv-rail"><div><h2>Kamera populer</h2><span>Lintas kota Indonesia</span></div><div class="cctv-feed-list">${[...feeds].reverse().map(card).join("")}</div></section>
    <footer>Analisis berjalan lokal pada frame yang terlihat. AVI bergantung pada codec browser; MP4/WebM direkomendasikan.</footer>
  </main>`;

  const canvas = root.querySelector<HTMLCanvasElement>("#cctv-placeholder")!;
  const context = canvas.getContext("2d")!;
  const video = root.querySelector<HTMLVideoElement>("#cctv-video")!;
  const stage = root.querySelector<HTMLElement>("#cctv-stage")!;
  const evidence = root.querySelector<HTMLElement>("#cctv-evidence")!;
  const answer = root.querySelector<HTMLElement>("#cctv-answer")!;
  let frame: FrameEvidence = { brightness: 0, dominant: "#0891b2", capturedAt: 0, note: "Belum ada frame" };
  let objectUrl = "";

  const drawPlaceholder = (color = "#0891b2") => {
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#06131d"); gradient.addColorStop(.55, color); gradient.addColorStop(1, "#111827");
    context.fillStyle = gradient; context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "rgba(255,255,255,.34)"; context.lineWidth = 8;
    for (let y = 230; y < 540; y += 65) { context.beginPath(); context.moveTo(0, y); context.lineTo(960, y - 120); context.stroke(); }
    for (let x = 70; x < 930; x += 120) { context.fillStyle = x % 240 ? "#f8fafc" : "#f59e0b"; context.fillRect(x, 310 + (x % 3) * 22, 54, 27); }
  };
  drawPlaceholder();

  const analyze = () => {
    try {
      const sample = document.createElement("canvas"); sample.width = 48; sample.height = 27;
      const cx = sample.getContext("2d", { willReadFrequently: true })!;
      cx.drawImage(video.hidden ? canvas : video, 0, 0, 48, 27);
      const pixels = cx.getImageData(0, 0, 48, 27).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; }
      const count = pixels.length / 4; r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count);
      const dominant = `rgb(${r} ${g} ${b})`; const brightness = Math.round((r * .299 + g * .587 + b * .114) / 2.55);
      frame = { brightness, dominant, capturedAt: Date.now(), note: brightness < 35 ? "Kondisi gelap; detail objek terbatas." : brightness > 72 ? "Pencahayaan terang; frame cukup terbaca." : "Pencahayaan sedang; verifikasi manual tetap diperlukan." };
      stage.style.setProperty("--ambient", dominant); evidence.innerHTML = `<b>${frame.note}</b><span>Cahaya ${brightness}% · warna dominan ${escapeHtml(dominant)} · ${new Date().toLocaleTimeString("id-ID")}</span>`;
    } catch { evidence.textContent = "Frame belum dapat dibaca dari sumber lintas-origin."; }
  };
  analyze(); const timer = window.setInterval(analyze, 1000);

  root.querySelector<HTMLInputElement>("#cctv-file")!.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = URL.createObjectURL(file); video.src = objectUrl; video.hidden = false; canvas.hidden = true;
    void video.play().catch(() => { answer.textContent = "Tekan play untuk memulai sumber video. Codec AVI tidak selalu didukung browser."; });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-feed]").forEach((button) => button.addEventListener("click", () => {
    const item = feeds[Number(button.dataset.feed) || 0]; root.querySelector("#cctv-title")!.textContent = item[0]; root.querySelector("#cctv-city")!.textContent = item[1];
    video.pause(); video.hidden = true; canvas.hidden = false; drawPlaceholder(item[2]); analyze(); stage.scrollIntoView({ behavior: "smooth", block: "center" });
  }));
  root.querySelector<HTMLButtonElement>("#cctv-fullscreen")!.addEventListener("click", () => void stage.requestFullscreen());
  const ai = root.querySelector<HTMLElement>("#cctv-ai")!; const openAi = () => ai.classList.add("is-open");
  root.querySelector("#cctv-chat")!.addEventListener("click", openAi); root.querySelector("#cctv-ai-open")!.addEventListener("click", openAi); root.querySelector("#cctv-ai-close")!.addEventListener("click", () => ai.classList.remove("is-open"));
  root.querySelector<HTMLFormElement>("#cctv-ai-form")!.addEventListener("submit", (event) => { event.preventDefault(); const q = root.querySelector<HTMLTextAreaElement>("#cctv-question")!.value.trim(); if (!q) return; answer.innerHTML = `<b>Jawaban berbasis frame terakhir</b><p>${escapeHtml(frame.note)} Kecerahan terukur ${frame.brightness}%. Untuk prediksi lalu lintas yang sah dibutuhkan rangkaian frame dan histori kamera; satu frame belum cukup untuk memastikan tren.</p>`; });
  root.querySelector<HTMLInputElement>("#cctv-search")!.addEventListener("input", (event) => { const q = (event.currentTarget as HTMLInputElement).value.toLocaleLowerCase(); root.querySelectorAll<HTMLElement>(".cctv-card").forEach((node) => node.hidden = !node.textContent!.toLocaleLowerCase().includes(q)); });
  window.addEventListener("pagehide", () => { clearInterval(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); }, { once: true });
}
