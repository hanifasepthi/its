# ITS Controller

Program Scala utama untuk Raspberry Pi. Default-nya menulis snapshot JSON yang dipoll dashboard GitHub Pages.

## Run

```bash
cd controller
chmod +x run-controller.sh
./run-controller.sh
```

## Environment

```bash
export ITS_OUTPUT_PATH="../web/public/data/its-state.json"
export ITS_DEVICE_ID="raspberry-its"
export ITS_DEVICE_LABEL="Raspberry Pi 5 Controller"
export ITS_DEVICE_DISTRICT="Koridor Utama ITS"
export ITS_INTERVAL_SECONDS="15"
```

Lokasi marker dikirim oleh controller. Default-nya `Main.scala` mengambil `lat/lng` dari IP geolocation perangkat, lalu publish ke Firebase:

```bash
export ITS_IP_GEOLOCATION_URLS="https://ipapi.co/json/,https://ipwho.is/"
export ITS_GEO_REFRESH_SECONDS="15"
```

Kalau perlu koordinat manual sebagai override, set:

```bash
export ITS_LOCATION_MODE="manual"
export ITS_LATITUDE="-7.280734"
export ITS_LONGITUDE="112.794963"
```

## Auto run

Pakai file [its-controller.service](its-controller.service) lalu aktifkan dengan systemd.

Verifikasi setelah reboot:

```bash
sudo systemctl status its-controller.service
journalctl -u its-controller.service -f
```

Kalau statusnya `active (running)`, controller memang auto jalan seperti service, bukan seperti upload firmware Arduino.
