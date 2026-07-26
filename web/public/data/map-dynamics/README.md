# ITS Maps dynamic map data

Data peta tambahan tidak dikirim sebagai satu JSON nasional. Browser hanya
mengambil shard yang berpotongan dengan viewport, lalu menggabungkannya dengan
delta terverifikasi dari Cloudflare Worker.

- `manifest.json` adalah indeks kecil yang berubah ketika versi dataset dirilis.
- `feature.schema.json` menjaga atribut jalan, rute, air, provenance, dan ornamen tetap konsisten.
- `shards/` berisi GeoJSON immutable, idealnya 1–8 MB per berkas.
- hasil computer vision masuk sebagai `observation`; hasil itu tidak ditampilkan
  kepada publik sampai geometri, sumber, nama, dan keyakinannya diverifikasi.
- data OSM/Overpass tetap menjadi sumber dinamis nasional dan cache lokal;
  shard ITS hanya menyimpan koreksi/pengayaan yang mempunyai provenance.

Bangun shard dari GeoJSON atau NDJSON yang sudah diverifikasi:

```text
npm run map:data:build -- --input path/to/verified.geojson
```

## Ingest internet bertahap

Overpass hanya diambil untuk satu sel kecil per eksekusi. Daftar sel berada di
`scripts/map-dynamics-ingest/regions.json`; cursor lokal disimpan secara atomik
di `.map-dynamics-ingest/checkpoint.json` sehingga eksekusi berikutnya lanjut ke
sel selanjutnya, bukan melakukan sweep nasional.

```text
node scripts/ingest-map-dynamics-overpass.mjs --region telkom-university-bandung
node scripts/ingest-map-dynamics-overpass.mjs --bbox 107.61,-6.99,107.65,-6.95
node scripts/ingest-map-dynamics-overpass.mjs --region telkom-university-bandung --dry-run
node scripts/ingest-map-dynamics-overpass.mjs --coverage-grid --dry-run
npm run map:data:ingest:check
```

Pada PowerShell dengan npm 10, opsi skrip dapat dijalankan melalui
`npm run map:data:ingest -- -- --region telkom-university-bandung`; pemisah `--`
tambahan mencegah npm mengambil opsi milik skrip.

`--coverage-grid` mengaktifkan antrian nasional virtual. Dua priority region
tetap berada di urutan pertama, kemudian sel berukuran maksimum `0.04° × 0.04°`
dihitung saat runtime dari bounding partition kepulauan. Sel tidak pernah
ditulis sebagai JSON nasional besar. Sel yang overlap dengan priority tetap
diproses agar sisa sel di luar bbox priority tidak hilang, dan satu invocation
hanya membangun satu query bbox. Cursor coverage terpisah
disimpan dalam checkpoint; output dry-run melaporkan `currentCell` dan
`totalCells` agar progres dapat diaudit.

Hasil ingest masuk ke `.map-dynamics-ingest/observations/` dengan status
`observation`, `publishable: false`, URL elemen OSM, endpoint Overpass,
timestamp, checksum respons, atribusi OpenStreetMap, dan lisensi ODbL. Nama dan
geometri hanya disalin jika benar-benar ada pada respons; way tanpa geometri
tidak dibuatkan garis atau titik perkiraan.

Member way dalam relation transit tidak diterbitkan sebagai ribuan segmen
terpisah. Urutan member dirangkai menjadi komponen `LineString` dengan pembalikan
endpoint bila perlu dan toleransi sambungan maksimum 45 meter. Bagian yang
terputus tetap menjadi komponen berbeda; relation ID, `from`, `to`, `ref`,
operator, network, jumlah member, jumlah komponen, dan statistik gap disimpan.

Ingest dan publikasi sengaja merupakan dua tahap berbeda. Observation harus
ditinjau manusia terlebih dahulu. Reviewer kemudian membuat berkas terpisah
berstatus `verified` beserta provenance verifikasinya; hanya berkas itulah yang
boleh diberikan kepada `map:data:build`. Builder tetap menolak observation.

Promosi OSM yang sudah ditinjau memakai approval eksplisit dari
`scripts/map-dynamics-ingest/approval.template.json`. Approval mengunci hash
input, identitas reviewer, waktu/review ID, dan daftar ID fitur yang diperiksa;
wildcard tidak diterima. Fitur yang tidak tercantum tetap dikarantina.

```text
node scripts/promote-map-dynamics-observations.mjs --input observation.geojson --hash-only
node scripts/promote-map-dynamics-observations.mjs --input observation.geojson --approval approval.json --check-only
node scripts/promote-map-dynamics-observations.mjs --input observation.geojson --approval approval.json --output reviewed.verified.geojson
npm run map:data:promote:check
```

Validator hanya menerima observation asli dari OpenStreetMap/Overpass dengan
ODbL, URL/provenance elemen yang cocok, geometri valid, serta nama/ref yang
identik dengan tag sumber. Observation dari computer vision/AI tidak dapat
dipromosikan oleh jalur ini. Output terverifikasi kemudian dapat diberikan ke
`map:data:build`.

## Snapshot OSM source-integrity

Untuk snapshot produksi yang langsung berasal dari fetch Overpass yang sama,
mode eksplisit berikut menghasilkan GeoJSON builder-ready tanpa berpura-pura
telah diverifikasi di lapangan:

```text
node scripts/ingest-map-dynamics-overpass.mjs --region telkom-university-bandung --source-verified-osm
node scripts/ingest-map-dynamics-overpass.mjs --coverage-grid --source-verified-osm
```

Mode ini hanya menerima endpoint Overpass HTTPS yang terkonfigurasi dan tidak
dapat digunakan terhadap berkas staging/CV/AI. Fiturnya memakai
`verification: verified`, `verificationScope: source-integrity`,
`fieldVerified: false`, `manualVerified: false`, serta
`verifiedBy: OpenStreetMap source-integrity pipeline`. Checksum respons mentah,
URL elemen, metadata OSM, atribusi, dan ODbL dipertahankan. Output default masuk
ke `.map-dynamics-ingest/source-verified/` dan dapat diberikan langsung kepada
`map:data:build`; status tersebut hanya menjamin integritas sumber, bukan
ketepatan hasil survei lapangan.

Pipeline membatasi luas bbox, jumlah elemen, byte respons, timeout, dan retry.
Jangan memperbesar batas untuk mengambil Indonesia sekaligus. Untuk beban besar,
gunakan instance Overpass sendiri dan tetap pertahankan atribusi ODbL.

Satu berkas multi-gigabyte sengaja dilarang karena tidak dapat diparsing secara
aman oleh browser dan tidak sesuai batas file GitHub/Firebase Hosting.
