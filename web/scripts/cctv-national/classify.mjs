export function classifyStream(url, contentType = "", sample = "") {
  const u = String(url || "");
  const ct = String(contentType || "").toLowerCase();
  const s = String(sample || "").slice(0, 8192);
  if (/application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(ct) || /\.m3u8(?:$|[?#])/i.test(u) || /^\s*#EXTM3U/m.test(s)) return "hls";
  if (/application\/dash\+xml/i.test(ct) || /\.mpd(?:$|[?#])/i.test(u) || /<MPD(?:\s|>)/i.test(s)) return "dash";
  if (/video\/mp4/i.test(ct) || /\.mp4(?:$|[?#])/i.test(u)) return "mp4";
  if (/video\/webm/i.test(ct) || /\.webm(?:$|[?#])/i.test(u)) return "webm";
  if (/video\/mp2t/i.test(ct) || /\.(?:ts|m2ts)(?:$|[?#])/i.test(u)) return "mpegts";
  if (/multipart\/x-mixed-replace/i.test(ct) || /(?:mjpeg|mjpg)/i.test(u)) return "mjpeg";
  if (/image\/jpeg/i.test(ct) || /\.(?:jpe?g)(?:$|[?#])/i.test(u)) return "jpeg";
  if (/video\/(?:x-msvideo|avi)/i.test(ct) || /\.avi(?:$|[?#])/i.test(u)) return "avi";
  if (/^rtsp:\/\//i.test(u)) return "rtsp";
  if (/^rtmps?:\/\//i.test(u)) return "rtmp";
  // A portal can embed or merely link to YouTube while its own URL is still
  // an HTML page. Classify the response itself before scanning embedded URLs.
  if (/text\/html/i.test(ct) || /<html[\s>]|<!doctype html/i.test(s)) return "html-page";
  if (/youtube\.com|youtu\.be/i.test(u)) return "youtube";
  if (/webrtc|RTCPeerConnection|whep|whip/i.test(s)) return "webrtc-page";
  return "unknown";
}

export function browserPlayable(type) {
  return ["hls","dash","mp4","webm","mjpeg","jpeg","youtube","html-page"].includes(type);
}
