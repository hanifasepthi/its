# ITS Maps Cloudflare Edge

Worker ini mempertahankan `its.hanifahseptiani45.workers.dev` sebagai mirror `itstelkom.web.app`, sekaligus menyediakan backend berikut:

- Workers AI untuk inferensi cloud dengan fallback model ONNX lokal di browser;
- AI Gateway `default` untuk routing dan observability panggilan model;
- AI Search `its-maps-public` dan Vectorize `its-maps-knowledge` untuk RAG dokumentasi publik;
- remote MCP stateless di `/mcp`;
- JSON peta dinamis bertile: hanya shard/delta terverifikasi yang dibaca publik, sedangkan hasil computer vision masuk karantina KV;
- subscription Firebase Cloud Messaging, KV, Queue, retry, deduplikasi event, broadcast admin, dan pemeriksaan release terjadwal;
- webhook controller dengan HMAC, tanpa menjadikan write publik RTDB sebagai pemicu push.

Tidak ada Cloudflare API token, Firebase private key, token FCM, atau admin token di source/bundle.

## Provisioning

1. AI Gateway `default` dibuat otomatis oleh Cloudflare saat panggilan Workers AI pertama. Model Catalog pada menu **AI > Models** tersedia melalui Workers AI; model tidak perlu diunduh ke repo.
2. Di Firebase Console, buka **Project settings > Cloud Messaging > Web Push certificates**, lalu buat/import pasangan VAPID dan salin public key.
3. Login dan jalankan deploy dari PowerShell:

```powershell
cd web/cloudflare-worker
npx wrangler login
$env:ITS_FIREBASE_VAPID_PUBLIC_KEY = "PUBLIC_VAPID_KEY"
$env:ITS_PUSH_ADMIN_TOKEN = "random-secret-minimum-32-characters"
$env:ITS_CONTROLLER_WEBHOOK_SECRET = "different-secret-minimum-32-characters"
./scripts/deploy-cloudflare.ps1 -FirebaseServiceAccountPath "../../itstelkom-firebase-adminsdk-fbsvc-REPLACE.json"
```

Backend data peta membutuhkan dua secret tambahan yang berbeda. Set setelah login dan sebelum deployment produksi; jangan menaruh nilainya di `wrangler.jsonc`:

```powershell
cd web/cloudflare-worker
npx wrangler secret put MAP_ADMIN_TOKEN
npx wrangler secret put MAP_OBSERVATION_HMAC_SECRET
```

`MAP_ADMIN_TOKEN` mengizinkan publikasi data yang sudah ditinjau. `MAP_OBSERVATION_HMAC_SECRET` hanya mengizinkan ingest observasi CV ke karantina dan tidak dapat memublikasikan data.

Deployment awal tidak mewajibkan R2 sehingga Worker yang sudah ada tidak rusak. Untuk mengaktifkan shard baseline immutable, bootstrap bucket secara terpisah:

```powershell
cd web/cloudflare-worker
npx wrangler r2 bucket create its-maps-map-archive
```

Setelah bucket benar-benar berhasil dibuat, tambahkan binding berikut ke `wrangler.jsonc`, lalu jalankan dry-run sebelum deploy:

```jsonc
"r2_buckets": [
  {
    "binding": "MAP_ARCHIVE",
    "bucket_name": "its-maps-map-archive"
  }
]
```

Tanpa binding tersebut endpoint delta dan observasi tetap bekerja, tetapi upload `kind=shard` ditolak secara eksplisit. Jangan menambahkan binding sebelum bucket tersedia karena Wrangler akan menolak deployment.

Wrangler membuat KV serta Durable Object budget otomatis. Script membuat Vectorize 1.024 dimensi, Queue delivery, dan dead-letter Queue sebelum deploy, menyimpan credential sebagai Worker secrets, lalu mengunggah `llms.txt` dan `llms-full.txt` ke AI Search serta Vectorize. Jangan memakai file service-account sebagai asset dan jangan commit `.dev.vars`.

Account ID saja tidak dapat melakukan deployment. Jika `wrangler login` tidak dipakai, set `CLOUDFLARE_API_TOKEN` dengan scope minimum untuk Workers Scripts, Workers AI, Vectorize, AI Gateway, AI Search, KV, dan Queues.

Deployment berikutnya dapat dijalankan oleh `.github/workflows/cloudflare-deploy.yml` setelah bootstrap pertama selesai. Tambahkan repository secret `CLOUDFLARE_API_TOKEN`; secret runtime Firebase/FCM tetap tersimpan di Cloudflare karena konfigurasi memakai `keep_vars`, sehingga private key tidak perlu dimasukkan ke workflow GitHub.

## Endpoint

| Endpoint | Fungsi | Akses |
| --- | --- | --- |
| `GET /v1/health` | Status binding tanpa inference | Publik |
| `GET /v1/ai/models` | Model aktif dan peran model | Publik |
| `POST /v1/ai/generate` | Runtime model untuk orchestrator browser | Origin dibatasi + rate limit |
| `POST /v1/ai/chat` | RAG + satu panggilan Workers AI | Origin dibatasi + rate limit |
| `GET/POST /v1/ai/search` | Retrieval AI Search + Vectorize | Origin dibatasi + rate limit |
| `POST /v1/admin/knowledge/setup` | Buat/isi knowledge index | Bearer admin |
| `GET /v1/map/manifest` | Versi schema, statistik, dan guardrail dataset verified | Publik + cache edge |
| `GET /v1/map/deltas?bbox=...` | Shard/delta verified yang beririsan dengan viewport | Publik + rate limit + cache edge |
| `POST /v1/map/observations` | Simpan batch hasil CV ke prefix KV karantina | HMAC SHA-256; tidak dipublikasikan |
| `POST /v1/admin/map/verified` | Upload/revisi shard atau delta yang sudah diverifikasi | Bearer `MAP_ADMIN_TOKEN` |
| `GET /v1/push/config` | Public VAPID/sender state | Publik |
| `POST/DELETE /v1/push/subscriptions` | Opt-in/opt-out token FCM | Origin dibatasi + rate limit |
| `POST /v1/push/broadcast` | Fan-out ke Queue | Bearer admin |
| `POST /v1/events/controller` | Event controller terautentikasi | HMAC SHA-256 |
| `POST /mcp` | MCP Streamable HTTP stateless | Publik + rate limit, read-only tools |

Contoh broadcast:

```powershell
$headers = @{ Authorization = "Bearer $env:ITS_PUSH_ADMIN_TOKEN" }
$body = @{
  eventId = "release-1.0.52"
  title = "ITS Maps 1.0.52"
  body = "Pembaruan peta dan AI Cloudflare tersedia."
  url = "https://itstelkom.web.app/new"
  topic = "release"
  tag = "its-release"
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "https://its.hanifahseptiani45.workers.dev/v1/push/broadcast" -Headers $headers -ContentType "application/json" -Body $body
```

## JSON peta verified dan karantina CV

Schema `its-map-data-v1` memakai tile Web Mercator `z/x/y`, `bbox` berurutan `[minLng,minLat,maxLng,maxLat]`, ID stabil, revision integer yang selalu naik, dan provenance wajib. Ukuran request, jumlah feature, vertex, luas viewport, jumlah record respons, serta jumlah entri indeks dibatasi ketat agar aman untuk free tier.

Pembagian penyimpanan sengaja tegas:

- `EDGE_STATE` KV hanya menyimpan manifest, indeks spasial, pointer shard, delta kecil maksimal 128 KiB, nonce, dan observasi karantina maksimal 128 KiB;
- `MAP_ARCHIVE` R2 opsional menyimpan shard verified yang immutable, maksimal sekitar 768 KiB per upload Worker;
- satu dataset Indonesia tidak pernah dibentuk atau diunduh sebagai satu JSON multi-GB.

Contoh upload delta terverifikasi:

```json
{
  "schemaVersion": "its-map-data-v1",
  "kind": "delta",
  "id": "jakarta-sudirman-2026-07-21",
  "dataset": "roads",
  "revision": 1,
  "tile": { "z": 14, "x": 13053, "y": 8475 },
  "bbox": [106.818, -6.216, 106.824, -6.208],
  "generatedAt": "2026-07-21T03:00:00.000Z",
  "provenance": {
    "source": "OpenStreetMap + pemeriksaan operator",
    "sourceUrl": "https://www.openstreetmap.org/",
    "license": "ODbL-1.0",
    "capturedAt": "2026-07-21T02:45:00.000Z",
    "verifiedBy": "its-map-reviewer",
    "method": "manual-review",
    "observationBatchIds": []
  },
  "features": [
    {
      "type": "Feature",
      "id": "osm-way-123456",
      "properties": {
        "operation": "upsert",
        "kind": "road",
        "name": "Jalan Jenderal Sudirman",
        "highway": "primary"
      },
      "geometry": {
        "type": "LineString",
        "coordinates": [[106.819, -6.215], [106.823, -6.209]]
      }
    }
  ]
}
```

Kirim dengan `Authorization: Bearer <MAP_ADMIN_TOKEN>` ke `/v1/admin/map/verified`. Revision yang sama dengan isi berbeda ditolak; retry dengan isi identik bersifat idempotent. Feature delta memakai `properties.operation` bernilai `upsert` atau `delete`. Shard hanya menerima `upsert`, wajib memakai R2, dan object key mengandung revision+checksum sehingga immutable.

Endpoint viewport menerima `bbox`, atau `tile=z/x/y`, serta filter opsional `datasets`, `kind`, `since`, dan `limit`. Respons memuat metadata record verified beserta provenance/checksum dan `collection` GeoJSON yang langsung dapat dibaca `MapDynamicsLoader`. Worker menimpa field keamanan setiap feature dengan nilai envelope yang telah diautentikasi: `verification=verified`, source/sourceId stabil, revision, updatedAt, dataset, serta provenance. Geometri multipart dipecah secara deterministik menjadi Point/LineString/Polygon; tombstone `delete` dihitung pada `omittedDeletes` tetapi tidak dikirim sebagai geometri renderable. Jika `truncated=true`, klien harus memperkecil viewport atau membagi permintaan per tile; jangan mencoba mengambil seluruh Indonesia dalam satu request.

Batch CV memakai header:

```text
X-ITS-Timestamp: epoch-seconds
X-ITS-Nonce: random-unique-16-chars-or-more
X-ITS-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + nonce + "." + rawJsonBody)
```

Body observasi berisi `batchId`, `tile`, `bbox`, `capturedAt`, sumber model/imagery/lisensi, dan maksimal 160 kandidat geometri. Worker menyimpannya dengan `reviewState=quarantined`, `published=false`, retention terbatas, serta replay protection. Prefix karantina tidak pernah dibaca `/v1/map/manifest` atau `/v1/map/deltas`. Hasil CV baru dapat tampil setelah reviewer membuat record verified baru; provenance `method=reviewed-cv` wajib merujuk `observationBatchIds` yang masih ada di karantina.

Computer vision hanya menjadi petunjuk geometri. Nama jalan, toko buka/tutup, identitas rute, dan status fasilitas tidak boleh disimpulkan dari pixel tanpa sumber data serta verifikasi tambahan.

## Free-tier guardrail

“Gratis” berarti hard-capped dalam kuota, bukan kapasitas tanpa batas. Konfigurasi ini memakai satu generasi per permintaan, batas input/output, rate limit, AI Gateway, dan fallback lokal ketika cloud gagal/kuota habis.

- Workers Free: 100.000 request/hari.
- Workers AI: 10.000 neuron/hari tanpa biaya; pada Free plan operasi berikutnya gagal setelah kuota habis.
- Vectorize Free: 30 juta queried-vector dimensions/bulan dan 5 juta stored-vector dimensions. Dengan BGE-M3 1.024 dimensi, jaga indeks sekitar 4.800 chunk atau kurang.
- AI Search open beta: gratis sampai 20.000 query/bulan dalam batas beta; pemakaian Workers AI/Gateway tetap dihitung terpisah.
- Firebase Cloud Messaging tidak berbayar.

Worker memakai rate-limit binding Cloudflare dan Durable Object transaksional untuk budget global 250 eksekusi Workers AI per hari. Budget aplikasi adalah lapisan konservatif; hard cap paket Workers AI Free tetap menjadi batas akhir agar pemakaian tidak berubah menjadi tagihan. Request chat ke Gateway memakai `skipCache`; jangan aktifkan cache atau rate limit pada Gateway `default` karena Gateway tersebut juga dipakai AI Search. Token push kedaluwarsa otomatis setelah 180 hari tanpa refresh, dan kegagalan delivery terakhir masuk ke `its-maps-push-dead-letter`.

KV Free hanya menyediakan total penyimpanan sekitar 1 GB serta kuota operasi baca/tulis, sehingga KV tidak boleh menjadi gudang dataset nasional atau file lebih dari 5 GB. Pipeline peta hanya memakainya untuk metadata, delta kecil, dan karantina sementara. Shard baseline dipisahkan ke R2 opsional setelah bootstrap. R2 juga memiliki kuota dan bukan kapasitas tanpa batas. Konfigurasi ini tidak menjanjikan kapasitas tanpa batas; bila volume tumbuh, dataset harus dipartisi lebih lanjut dan biaya/object lifecycle harus dipantau.

Referensi resmi: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), [AI Search limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/), dan [Firebase background messaging](https://firebase.google.com/docs/cloud-messaging/web/receive-messages).

Web Push dapat membangunkan service worker saat tidak ada tab terbuka. Browser/OS tetap dapat menunda pesan; force-stop aplikasi, mematikan background browser, atau mencabut izin membuat delivery tidak dapat dijamin sampai browser diaktifkan kembali.

Catatan keamanan data: cabang `devices` pada rules RTDB lama masih menerima public write agar controller lama tetap berjalan. MCP menandai status perangkat sebagai `verified: false`; jangan memakai nilai tersebut untuk keputusan keselamatan. Migrasi berikutnya sebaiknya memberi setiap controller identitas Firebase/Auth yang unik, baru kemudian menutup public write dan menerapkan validasi schema.
