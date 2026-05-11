# ITS Maps

Realtime map untuk Raspberry Pi controller. Snapshot perangkat ditulis ke Firebase Realtime Database, lalu frontend membacanya langsung untuk menampilkan satu marker aktif.

## Struktur

- `web/` - frontend Vite static yang bisa dipublish ke GitHub Pages
- `controller/` - program Scala utama untuk Raspberry Pi
- `web/public/data/its-state.json` - sample snapshot JSON dengan format Firebase RTDB
- `web/public/data/its-config.json` - konfigurasi sumber snapshot dan interval refresh

## Jalankan frontend

```bash
cd web
npm install
npm run dev
```

## Build frontend

```bash
cd web
npm run build
```

## Raspberry Pi controller

```bash
cd controller
./run-controller.sh
```

## Firebase RTDB

Controller Scala mengirim snapshot realtime ke Firebase Realtime Database pada path `devices/raspberry-its.json`.
Frontend membaca snapshot yang sama untuk menampilkan marker, status, dan waktu terakhir.

Kalau ingin mengganti device ID atau koordinat, atur lewat environment variable di Raspberry Pi:

```bash
ITS_DEVICE_ID=raspberry-its
ITS_DEVICE_LABEL="Raspberry Pi 5 Controller"
ITS_STATUS=online
```

Secara default controller mengambil `lat/lng` dari IP geolocation perangkat yang menjalankan `Main.scala`, lalu mengirimkannya ke Firebase. Frontend hanya membaca posisi dari Firebase untuk marker. Kalau ingin override manual, baru set:

```bash
ITS_LOCATION_MODE=manual
ITS_LATITUDE=-7.280734
ITS_LONGITUDE=112.794963
```

Provider IP geolocation bisa diganti tanpa edit kode:

```bash
ITS_IP_GEOLOCATION_URLS="https://ipapi.co/json/,https://ipwho.is/"
ITS_GEO_REFRESH_SECONDS=15
```

Jika database membutuhkan aturan akses khusus, sesuaikan Firebase Realtime Database rules agar path tersebut bisa dibaca dan ditulis oleh controller.

## GitHub Pages

Deploy frontend tetap disarankan lewat GitHub Pages dari folder `web/dist`.
URL Pages untuk fork aktif adalah https://galihru.github.io/its/

## Workflow Contributor

Kalau kamu bukan pemilik repo utama, pakai fork itu benar. Alur amannya:

1. Fork repo utama ke akun GitHub kamu.
2. Kerjakan perubahan di fork.
3. Push branch ke fork kamu.
4. Aktifkan GitHub Pages di fork tersebut.
5. Jalankan controller Scala di Raspberry Pi dan pastikan `ITS_FIREBASE_URL` mengarah ke path RTDB yang aktif.

## Raspberry Pi

Program controller di folder `controller/` bukan seperti Arduino firmware. Dia bisa auto-run saat boot kalau dipasang sebagai service systemd.

Untuk cek auto-run di Pi:

```bash
cd controller
./run-controller.sh --once
sudo cp its-controller.service /etc/systemd/system/its-controller.service
sudo systemctl daemon-reload
sudo systemctl enable --now its-controller.service
sudo systemctl status its-controller.service
```

Kalau service aktif, berarti program memang jalan otomatis setelah boot.
