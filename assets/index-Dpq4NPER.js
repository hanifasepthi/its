(function(){const r=document.createElement("link").relList;if(r&&r.supports&&r.supports("modulepreload"))return;for(const n of document.querySelectorAll('link[rel="modulepreload"]'))s(n);new MutationObserver(n=>{for(const i of n)if(i.type==="childList")for(const p of i.addedNodes)p.tagName==="LINK"&&p.rel==="modulepreload"&&s(p)}).observe(document,{childList:!0,subtree:!0});function d(n){const i={};return n.integrity&&(i.integrity=n.integrity),n.referrerPolicy&&(i.referrerPolicy=n.referrerPolicy),n.crossOrigin==="use-credentials"?i.credentials="include":n.crossOrigin==="anonymous"?i.credentials="omit":i.credentials="same-origin",i}function s(n){if(n.ep)return;n.ep=!0;const i=d(n);fetch(n.href,i)}})();var l={updatedAt:177787e7,source:"demo",devices:[{id:"raspberry-its",label:"Raspberry Pi 5 Controller",district:"Koridor Utama ITS",ip:"10.176.37.67",status:"online",vehicles:28,congestion:62,speedKph:31,camera:"pending",note:"controller aktif; kamera belum terpasang",lastSeen:1777869995e3,position:{x:54.8,y:48.5}},{id:"edge-sensor-02",label:"Edge Sensor Timur",district:"Simpang Timur",ip:"10.176.37.82",status:"offline",vehicles:9,congestion:18,speedKph:40,camera:"offline",note:"node cadangan belum online",lastSeen:177786888e4,position:{x:70.5,y:38.7}},{id:"camera-gate-01",label:"Camera Gate Selatan",district:"Gerbang Selatan",ip:"10.176.37.120",status:"degraded",vehicles:41,congestion:78,speedKph:22,camera:"pending",note:"AI detector menunggu kamera fisik",lastSeen:1777869972e3,position:{x:43.8,y:69.5}}],events:[{id:"ev-1",time:177786982e4,label:"Heartbeat Raspberry Pi",detail:"device raspberry-its mengirim status online",severity:"good",deviceId:"raspberry-its"},{id:"ev-2",time:17778696e5,label:"Lonjakan kendaraan",detail:"koridor timur naik ke 78% congestion",severity:"warn",deviceId:"camera-gate-01"}]},f=l.devices[0],D=document.querySelector("#app");if(!D)throw new Error("Missing #app element.");D.innerHTML=`
  <div class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">ITS live map</p>
        <h1>Raspberry Pi traffic controller dashboard</h1>
        <p class="hero-copy">Dashboard ini membaca JSON statis dari GitHub Pages. Nanti saat controller Scala aktif, data tinggal diganti oleh snapshot realtime yang ditulis ke file JSON atau endpoint publik yang kamu pilih.</p>
      </div>
      <div class="hero-badges">
        <span id="backendBadge" class="badge">Github JSON</span>
        <span id="syncNote" class="sync">belum sinkron</span>
      </div>
    </header>

    <main class="layout">
      <section class="map-card">
        <div class="card-head">
          <div>
            <p class="eyebrow">Traffic map</p>
            <h2>Digital twin koridor ITS</h2>
          </div>
          <button id="refreshBtn" class="tool-btn" type="button">Refresh</button>
        </div>

        <div class="map-stage" id="mapStage">
          <svg class="map-svg" viewBox="0 0 1000 720" aria-hidden="true">
            <g id="riverLayer"></g>
            <g id="roadLayer"></g>
            <g id="labelLayer"></g>
          </svg>
          <div class="device-layer" id="deviceLayer"></div>
        </div>

        <div class="legend">
          <span><i class="dot good"></i>Online</span>
          <span><i class="dot warn"></i>Congestion watch</span>
          <span><i class="dot bad"></i>Offline</span>
          <span><i class="line"></i>Road corridor</span>
          <span><i class="water"></i>Water / boundary</span>
        </div>
        <div class="map-attribution">
          <span id="mapLabel">OpenStreetMap-style custom map</span>
          <span>Copyright ITS Telkom University</span>
        </div>
      </section>

      <aside class="side">
        <section class="stats">
          <article><small>Device aktif</small><strong id="activeDevices">0</strong><span id="offlineDevices">0 offline</span></article>
          <article><small>Jumlah kendaraan</small><strong id="vehicleTotal">0</strong><span>semua node</span></article>
          <article><small>Rata-rata congestion</small><strong id="averageCongestion">0%</strong><span>indikasi macet</span></article>
          <article><small>Kamera siap</small><strong id="cameraReady">0</strong><span>layer kamera</span></article>
        </section>

        <section class="panel">
          <div class="panel-headline">
            <div>
              <p class="eyebrow">Raspberry devices</p>
              <h3>Status node</h3>
            </div>
            <span id="syncAge" class="chip">demo</span>
          </div>
          <div id="deviceList" class="list"></div>
        </section>

        <section class="panel">
          <div class="panel-headline">
            <div>
              <p class="eyebrow">Event feed</p>
              <h3>Traffic signal</h3>
            </div>
          </div>
          <div id="eventFeed" class="feed"></div>
        </section>

        <section class="panel selected">
          <div class="panel-headline">
            <div>
              <p class="eyebrow">Selected device</p>
              <h3 id="selectedTitle">Raspberry Pi 5 Controller</h3>
            </div>
          </div>
          <div id="selectedBody"></div>
        </section>
      </aside>
    </main>
  </div>
`;var g={snapshotUrl:"./data/its-state.json",refreshMs:5e3,mapAttribution:"OpenStreetMap contributors",mapLabel:"Custom ITS map"},e={devices:[...l.devices],events:[...l.events],backend:"github-json",selectedId:f.id,updatedAt:l.updatedAt,zoom:1,config:g,refreshTimer:0,refreshBusy:!1},N=["M 110 140 C 250 110, 410 120, 560 160 S 760 220, 930 190","M 70 250 C 230 225, 360 245, 510 292 S 780 345, 965 315","M 90 420 C 250 390, 400 398, 540 438 S 785 510, 955 475","M 130 570 C 310 538, 470 548, 632 590 S 820 648, 965 618","M 215 90 C 180 180, 180 300, 208 400 S 255 560, 220 675","M 385 68 C 360 175, 365 286, 390 402 S 442 562, 430 690","M 610 90 C 585 198, 594 310, 620 420 S 674 560, 664 682","M 840 92 C 804 214, 808 321, 830 438 S 870 580, 864 680"],E=["M 20 640 C 140 600, 250 614, 360 602 S 590 540, 700 556 S 880 595, 980 575","M 30 612 C 155 578, 275 592, 396 580 S 630 522, 744 538 S 902 572, 972 560"],j=[{title:"Pusat ITS",x:51,y:35},{title:"Koridor Barat",x:18,y:43},{title:"Koridor Timur",x:78,y:30},{title:"Gerbang Selatan",x:44,y:79},{title:"Ruang Sungai",x:68,y:61}];function o(a){return a.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function u(a){return new Intl.NumberFormat("id-ID").format(a)}function v(a){const r=Math.max(0,Date.now()-a);return r<6e4?`${Math.max(1,Math.round(r/1e3))} detik lalu`:r<36e5?`${Math.max(1,Math.round(r/6e4))} menit lalu`:`${Math.max(1,Math.round(r/36e5))} jam lalu`}function B(){const a=document.querySelector("#roadLayer"),r=document.querySelector("#riverLayer"),d=document.querySelector("#labelLayer");!a||!r||!d||(a.innerHTML=N.map((s,n)=>`<path d="${s}" class="road road-${n%4}" />`).join(""),r.innerHTML=E.map(s=>`<path d="${s}" class="river" />`).join(""),d.innerHTML=j.map(s=>`
    <g transform="translate(${s.x*10}, ${s.y*10})">
      <rect x="-48" y="-14" width="96" height="24" rx="12" class="district-chip"></rect>
      <text x="0" y="2" text-anchor="middle" class="district-text">${o(s.title)}</text>
    </g>
  `).join(""))}function c(){return e.devices.find(a=>a.id===e.selectedId)??e.devices[0]??f}function K(a){return l.devices[a%l.devices.length]??f}function q(){const a=e.devices.filter(t=>t.status!=="offline").length,r=e.devices.length-a,d=e.devices.reduce((t,m)=>t+m.vehicles,0),s=Math.round(e.devices.reduce((t,m)=>t+m.congestion,0)/e.devices.length),n=e.devices.filter(t=>t.camera==="online").length,i=document.querySelector("#backendBadge"),p=document.querySelector("#syncNote"),y=document.querySelector("#syncAge"),b=document.querySelector("#activeDevices"),S=document.querySelector("#offlineDevices"),$=document.querySelector("#vehicleTotal"),w=document.querySelector("#averageCongestion"),L=document.querySelector("#cameraReady"),k=document.querySelector("#deviceList"),T=document.querySelector("#eventFeed"),x=document.querySelector("#selectedTitle"),C=document.querySelector("#selectedBody"),M=document.querySelector("#deviceLayer"),I=document.querySelector("#mapLabel");if(!i||!p||!y||!b||!S||!$||!w||!L||!k||!T||!x||!C||!M||!I)throw new Error("Missing ITS dashboard element.");i.textContent=e.backend==="github-json"?"GitHub JSON":"Demo mode",p.textContent=e.refreshBusy?"menarik snapshot terbaru...":`sinkron ${v(e.updatedAt)}`,y.textContent=e.backend==="github-json"?`live / ${Math.round(e.config.refreshMs/1e3)}s`:"demo",b.textContent=String(a),S.textContent=`${r} offline`,$.textContent=u(d),w.textContent=`${s}%`,L.textContent=String(n),I.textContent=`${e.config.mapLabel} · ${e.config.mapAttribution}`,M.innerHTML=e.devices.map(t=>`
    <button class="pin ${t.status} ${t.id===e.selectedId?"selected":""}" type="button" data-id="${o(t.id)}" style="left:${t.position.x}%; top:${t.position.y}%">
      <span class="pin-pulse"></span>
      <span class="pin-core"></span>
      <span class="pin-label">${o(t.label)}</span>
      <span class="pin-count">${u(t.vehicles)} kendaraan</span>
    </button>
  `).join(""),k.innerHTML=e.devices.map(t=>`
    <button class="device-row ${t.id===e.selectedId?"selected":""}" type="button" data-id="${o(t.id)}">
      <div class="row-top">
        <strong>${o(t.label)}</strong>
        <span class="status ${t.status}">${t.status}</span>
      </div>
      <div class="row-meta">
        <span>${o(t.district)}</span>
        <span>${o(t.ip||"no-ip")}</span>
      </div>
      <div class="row-stats">
        <span>${u(t.vehicles)} kendaraan</span>
        <span>${t.congestion}% macet</span>
        <span>${t.speedKph} km/jam</span>
      </div>
      <div class="row-foot">
        <span>Kamera: ${o(t.camera)}</span>
        <span>${v(t.lastSeen)}</span>
      </div>
    </button>
  `).join(""),T.innerHTML=e.events.map(t=>`
    <article class="event">
      <div class="bul ${t.severity}"></div>
      <div>
        <div class="event-head"><strong>${o(t.label)}</strong><time>${new Intl.DateTimeFormat("id-ID",{hour:"2-digit",minute:"2-digit"}).format(new Date(t.time))}</time></div>
        <p>${o(t.detail)}</p>
      </div>
    </article>
  `).join(""),x.textContent=c().label,C.innerHTML=`
    <div class="selected-grid">
      <div><span>ID</span><strong>${o(c().id)}</strong></div>
      <div><span>Status</span><strong>${o(c().status)}</strong></div>
      <div><span>District</span><strong>${o(c().district)}</strong></div>
      <div><span>Kamera</span><strong>${o(c().camera)}</strong></div>
    </div>
    <div class="selected-metrics">
      <div><span>Kendaraan</span><strong>${u(c().vehicles)}</strong></div>
      <div><span>Congestion</span><strong>${c().congestion}%</strong></div>
      <div><span>Speed</span><strong>${c().speedKph} km/jam</strong></div>
    </div>
    <p class="selected-note">${o(c().note||"Belum ada catatan.")}</p>
    <div class="selected-footer"><span>${o(c().ip||"-")}</span><span>Last seen ${v(c().lastSeen)}</span></div>
  `,document.querySelectorAll("[data-id]").forEach(t=>{t.onclick=()=>{e.selectedId=t.dataset.id||e.selectedId,q()}})}async function h(){if(!e.refreshBusy){e.refreshBusy=!0;try{const a=await fetch("./data/its-config.json",{cache:"no-store"});if(a.ok){const s=await a.json();e.config={...g,...s}}else e.config={...g};const r=await fetch(e.config.snapshotUrl,{cache:"no-store"});if(!r.ok)throw new Error("snapshot not found");const d=await r.json();Array.isArray(d.devices)&&d.devices.length&&(e.devices=d.devices.map((s,n)=>{const i=K(n);return{id:String(s.id||i.id),label:String(s.label||i.label),district:String(s.district||i.district),ip:String(s.ip||""),status:s.status||i.status,vehicles:Number(s.vehicles??0),congestion:Number(s.congestion??0),speedKph:Number(s.speedKph??0),camera:String(s.camera||"pending"),note:String(s.note||""),lastSeen:Number(s.lastSeen??Date.now()),position:{x:Number(s.position?.x??i.position.x),y:Number(s.position?.y??i.position.y)}}})),Array.isArray(d.events)&&d.events.length&&(e.events=d.events.map(s=>({id:String(s.id||`event_${Date.now()}`),time:Number(s.time??Date.now()),label:String(s.label||"Event"),detail:String(s.detail||""),severity:s.severity||"info",deviceId:String(s.deviceId||"")}))),e.backend="github-json",e.updatedAt=Number(d.updatedAt||Date.now())}catch{e.backend="demo",e.updatedAt=Date.now(),e.devices=[...l.devices],e.events=[...l.events]}e.devices.some(a=>a.id===e.selectedId)||(e.selectedId=e.devices[0]?.id||l.devices[0].id),B(),q(),window.clearInterval(e.refreshTimer),e.refreshTimer=window.setInterval(()=>{h()},e.config.refreshMs),e.refreshBusy=!1}}var A=document.querySelector("#refreshBtn");A&&A.addEventListener("click",()=>{h()});window.addEventListener("beforeunload",()=>{window.clearInterval(e.refreshTimer)});h();
