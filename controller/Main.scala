import java.nio.charset.StandardCharsets
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.URLEncoder
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardOpenOption
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object ItsController {
  private case class GeoLocation(
    lat: Double,
    lng: Double,
    source: String,
    label: String,
    accuracyM: Int
  )

  private val offlineAfterMs      = math.max(60_000, envInt("ITS_OFFLINE_AFTER_MS", 60_000))
  private val staleDeleteAfterMs  = math.max(offlineAfterMs, envInt("ITS_STALE_DELETE_AFTER_MS", 60_000).toLong)
  private val deviceId            = env("ITS_DEVICE_ID",    "raspberry-its")
  private val label               = env("ITS_DEVICE_LABEL", "Raspberry Pi 5 Controller")
  private val status              = env("ITS_STATUS",       "online")
  private val note                = env("ITS_NOTE",         "controller aktif")

  private val fallbackLatitude   = envDouble("ITS_FALLBACK_LATITUDE",  -7.280734)
  private val fallbackLongitude  = envDouble("ITS_FALLBACK_LONGITUDE", 112.794963)
  private val explicitLatitude   = envDoubleOpt("ITS_LATITUDE")
  private val explicitLongitude  = envDoubleOpt("ITS_LONGITUDE")
  private val locationMode       = env("ITS_LOCATION_MODE", "ip").toLowerCase(Locale.ROOT)

  private val intervalSeconds     = math.max(5, envInt("ITS_INTERVAL_SECONDS", 15))
  private val geoRefreshMs        = math.max(5_000L, envInt("ITS_GEO_REFRESH_SECONDS", intervalSeconds).toLong * 1000L)
  private val outputPath          = env("ITS_OUTPUT_PATH", "../web/public/data/its-state.json")
  private val ipGeolocationUrls   = env(
    "ITS_IP_GEOLOCATION_URLS",
    "https://ipapi.co/json/,https://ipwho.is/"
  ).split(",").map(_.trim).filter(_.nonEmpty).toSeq
  private val firebaseUrl         = env(
    "ITS_FIREBASE_BASE_URL",
    "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices"
  )
  private val firebaseAuth    = env("ITS_FIREBASE_AUTH", "")
  private var firebaseEnabled = env("ITS_FIREBASE_ENABLED", "true").toLowerCase(Locale.ROOT) != "false"
  private var cachedLocation: Option[(Long, GeoLocation)] = None

  private val httpClient = HttpClient.newHttpClient()
  private val lastSeenFormatter = DateTimeFormatter
    .ofPattern("EEEE, dd MMMM yyyy HH:mm:ss")
    .withLocale(new Locale("id", "ID"))
    .withZone(ZoneId.systemDefault())

  def main(args: Array[String]): Unit = {
    val startupLocation = currentLocation()
    println(s"ITS controller started — device=$deviceId lat=${startupLocation.lat} lng=${startupLocation.lng} source=${startupLocation.source} -> $outputPath")
    Runtime.getRuntime.addShutdownHook(new Thread(() => publishOfflineDevice()))
    // Saat startup: cek dan hapus node lama yang masih berisi nested snapshot wrapper
    migrateLegacyFirebaseNode()
    if (args.contains("--once")) {
      writeSnapshot()
      return
    }
    while (true) {
      writeSnapshot()
      Thread.sleep(intervalSeconds * 1000L)
    }
  }

  /**
   * Deteksi node lama di Firebase: devices/{deviceId} yang masih berisi
   * {"devices":[...],"source":...,"updatedAt":...} dan hapus sebelum
   * menulis struktur baru yang flat.
   * Dipanggil sekali saat startup.
   */
  private def migrateLegacyFirebaseNode(): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) return
    val nodePath = s"${firebaseUrl.stripSuffix("/")}/${deviceId}.json${authSuffixQuery()}"
    try {
      val getReq = HttpRequest.newBuilder(URI.create(nodePath))
        .header("Accept", "application/json").GET().build()
      val getResp = httpClient.send(getReq, HttpResponse.BodyHandlers.ofString())
      if (getResp.statusCode() < 200 || getResp.statusCode() >= 300) return
      val body = getResp.body().trim
      // Jika node lama mengandung "devices" key (nested), hapus dulu
      if (body.contains("\"devices\"")) {
        println(s"[${java.time.LocalDateTime.now()}] Detected legacy Firebase structure for $deviceId — deleting to migrate...")
        val delReq = HttpRequest.newBuilder(URI.create(nodePath)).DELETE().build()
        val delResp = httpClient.send(delReq, HttpResponse.BodyHandlers.ofString())
        if (delResp.statusCode() >= 200 && delResp.statusCode() < 300) {
          println(s"[${java.time.LocalDateTime.now()}] Legacy node deleted. Will write flat structure on next snapshot.")
        } else {
          println(s"[${java.time.LocalDateTime.now()}] Legacy delete failed: HTTP ${delResp.statusCode()}")
        }
      } else {
        println(s"[${java.time.LocalDateTime.now()}] Firebase node structure OK — no migration needed.")
      }
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Migration check error: ${ex.getMessage}")
    }
  }

  private def writeSnapshot(): Unit = {
    val (snapshotJson, deviceJson) = buildJsonPair()

    // Tulis file lokal (format snapshot penuh untuk web)
    val path = Paths.get(outputPath)
    val parent = path.getParent
    if (parent != null) Files.createDirectories(parent)

    Files.writeString(
      path, snapshotJson, StandardCharsets.UTF_8,
      StandardOpenOption.CREATE,
      StandardOpenOption.TRUNCATE_EXISTING,
      StandardOpenOption.WRITE
    )
    println(s"[${java.time.LocalDateTime.now()}] wrote ${path.toAbsolutePath}")

    // FIX: kirim hanya deviceJson (bukan snapshotJson) ke Firebase
    // agar struktur RTDB: devices/{deviceId} = {id, label, status, lastSeen, position, ...}
    publishFirebaseDevice(deviceJson)
    cleanupStaleNonRaspberryNodes()
  }

  /**
   * Mengembalikan dua string JSON:
   *   1. snapshotJson — format penuh untuk file lokal & web frontend
   *   2. deviceJson   — hanya data device, untuk disimpan di Firebase RTDB
   *
   * FIX: Sebelumnya hanya ada satu JSON (snapshotJson) yang dikirim ke Firebase,
   * sehingga node Firebase berisi {"updatedAt":...,"source":...,"devices":[...]}
   * alih-alih {id, label, status, lastSeen, position, ...}.
   * Frontend membaca Firebase dan mengharapkan struktur device langsung.
   */
  private def buildJsonPair(): (String, String) = {
    val lastSeen    = System.currentTimeMillis()
    val updatedAt   = lastSeen
    val lastSeenText = lastSeenFormatter.format(Instant.ofEpochMilli(lastSeen))
    val location = currentLocation()

    // Device JSON — struktur flat yang sesuai dengan SnapshotDevice di frontend
    val deviceJson =
      s"""{
         |  "id": "${escapeJson(deviceId)}",
         |  "label": "${escapeJson(label)}",
         |  "status": "${escapeJson(status)}",
         |  "lastSeen": $lastSeen,
         |  "lastSeenText": "${escapeJson(lastSeenText)}",
         |  "note": "${escapeJson(note)}",
         |  "locationSource": "${escapeJson(location.source)}",
         |  "locationLabel": "${escapeJson(location.label)}",
         |  "locationAccuracyM": ${location.accuracyM},
         |  "position": {
         |    "lat": ${location.lat},
         |    "lng": ${location.lng}
         |  }
         |}""".stripMargin

    // Snapshot JSON — wrapper untuk file lokal (web frontend membaca ini)
    val snapshotJson =
      s"""{
         |  "updatedAt": $updatedAt,
         |  "source": "scala-controller",
         |  "devices": [
         |    $deviceJson
         |  ]
         |}""".stripMargin

    (snapshotJson, deviceJson)
  }

  // ─── Firebase: publish device node ────────────────────────────

  /**
   * FIX: fungsi ini menggantikan publishFirebaseSnapshot.
   * Hanya mengirim deviceJson (bukan snapshotJson) ke path devices/{deviceId}.
   * Dengan demikian struktur RTDB menjadi benar dan frontend bisa parse
   * devices sebagai Record<string, SnapshotDevice>.
   */
  private def publishFirebaseDevice(deviceJson: String): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) return

    val devicePath = s"${firebaseUrl.stripSuffix("/")}/${deviceId}.json" +
      authSuffix()

    try {
      val request = HttpRequest
        .newBuilder(URI.create(devicePath))
        .header("Content-Type", "application/json")
        .PUT(HttpRequest.BodyPublishers.ofString(deviceJson))
        .build()

      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() >= 200 && response.statusCode() < 300) {
        val location = currentLocation()
        println(s"[${java.time.LocalDateTime.now()}] published device to Firebase RTDB: $deviceId @ (${location.lat}, ${location.lng}) from ${location.source}")
      } else {
        println(s"[${java.time.LocalDateTime.now()}] Firebase publish failed: HTTP ${response.statusCode()} — ${response.body().take(200)}")
        if (response.statusCode() == 401) {
          firebaseEnabled = false
          println(s"[${java.time.LocalDateTime.now()}] Firebase disabled: unauthorized. Set ITS_FIREBASE_AUTH atau periksa rules database.")
        }
      }
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Firebase publish error: ${ex.getMessage}")
    }
  }

  // ─── Firebase: cleanup stale nodes ────────────────────────────

  private def cleanupStaleNonRaspberryNodes(): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) return

    try {
      val request = HttpRequest
        .newBuilder(URI.create(s"${firebaseUrl.stripSuffix("/")}.json${authSuffixQuery()}"))
        .header("Accept", "application/json")
        .GET()
        .build()

      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() < 200 || response.statusCode() >= 300) {
        println(s"[${java.time.LocalDateTime.now()}] Firebase cleanup skipped: HTTP ${response.statusCode()}")
        return
      }

      val staleIds = extractStaleDeviceIds(response.body(), staleDeleteAfterMs)
        .filterNot(_.startsWith("raspberry"))
        .filterNot(_ == deviceId)

      staleIds.foreach(deleteDeviceNode)
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Firebase cleanup error: ${ex.getMessage}")
    }
  }

  private def deleteDeviceNode(id: String): Unit = {
    val deleteUrl = s"${firebaseUrl.stripSuffix("/")}/${id}.json${authSuffixQuery()}"
    try {
      val request = HttpRequest
        .newBuilder(URI.create(deleteUrl))
        .DELETE()
        .build()
      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() >= 200 && response.statusCode() < 300)
        println(s"[${java.time.LocalDateTime.now()}] deleted stale node $id from Firebase RTDB")
      else
        println(s"[${java.time.LocalDateTime.now()}] Firebase delete failed for $id: HTTP ${response.statusCode()}")
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Firebase delete error for $id: ${ex.getMessage}")
    }
  }

  private def extractStaleDeviceIds(json: String, staleAfterMs: Long): Seq[String] = {
    val entryPattern = """(?s)"([^\"]+)"\s*:\s*\{.*?"lastSeen"\s*:\s*(\d+)""".r
    val cutoff = System.currentTimeMillis() - staleAfterMs
    entryPattern.findAllMatchIn(json).flatMap { m =>
      val id       = m.group(1)
      val lastSeen = try m.group(2).toLong catch { case _: Throwable => 0L }
      if (lastSeen > 0 && lastSeen < cutoff) Some(id) else None
    }.toSeq
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /** Mengembalikan "?auth=..." atau "" */
  private def authSuffix(): String =
    if (firebaseAuth.trim.isEmpty) ""
    else s"?auth=${URLEncoder.encode(firebaseAuth.trim, StandardCharsets.UTF_8)}"

  /** Sama dengan authSuffix tapi untuk URL yang sudah diakhiri .json */
  private def authSuffixQuery(): String = authSuffix()

  private def publishOfflineDevice(): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) return
    val lastSeen = System.currentTimeMillis()
    val lastSeenText = lastSeenFormatter.format(Instant.ofEpochMilli(lastSeen))
    val location = currentLocation()
    val body =
      s"""{
         |  "id": "${escapeJson(deviceId)}",
         |  "label": "${escapeJson(label)}",
         |  "status": "offline",
         |  "lastSeen": $lastSeen,
         |  "lastSeenText": "${escapeJson(lastSeenText)}",
         |  "note": "${escapeJson(note)}; controller berhenti",
         |  "locationSource": "${escapeJson(location.source)}",
         |  "locationLabel": "${escapeJson(location.label)}",
         |  "locationAccuracyM": ${location.accuracyM},
         |  "position": {
         |    "lat": ${location.lat},
         |    "lng": ${location.lng}
         |  }
         |}""".stripMargin
    try publishFirebaseDevice(body)
    catch { case _: Throwable => () }
  }

  private def currentLocation(): GeoLocation = {
    manualLocation()
      .orElse(ipGeolocation())
      .orElse(firebaseLocation())
      .getOrElse(GeoLocation(
        fallbackLatitude,
        fallbackLongitude,
        "fallback",
        "fallback coordinate",
        50_000
      ))
  }

  private def manualLocation(): Option[GeoLocation] = {
    if (locationMode != "manual") return None
    for {
      lat <- explicitLatitude
      lng <- explicitLongitude
      if lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    } yield GeoLocation(lat, lng, "env", "ITS_LATITUDE/ITS_LONGITUDE", 0)
  }

  private def ipGeolocation(): Option[GeoLocation] = {
    val now = System.currentTimeMillis()
    cachedLocation match {
      case Some((updatedAt, location)) if now - updatedAt < geoRefreshMs =>
        return Some(location)
      case _ => ()
    }

    val fresh = ipGeolocationUrls.view.flatMap(fetchIpGeolocation).headOption
    fresh.foreach(location => cachedLocation = Some(now -> location))
    fresh
  }

  private def fetchIpGeolocation(url: String): Option[GeoLocation] = {
    try {
      val request = HttpRequest
        .newBuilder(URI.create(url))
        .header("Accept", "application/json")
        .header("User-Agent", "its-maps-controller/1.0")
        .GET()
        .build()
      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() < 200 || response.statusCode() >= 300) return None
      parseIpGeolocation(response.body(), url)
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] IP geolocation failed from $url: ${ex.getMessage}")
        None
    }
  }

  private def parseIpGeolocation(json: String, url: String): Option[GeoLocation] = {
    val lat =
      extractNumber(json, "latitude")
        .orElse(extractNumber(json, "lat"))
    val lng =
      extractNumber(json, "longitude")
        .orElse(extractNumber(json, "lon"))
        .orElse(extractNumber(json, "lng"))

    for {
      latitude <- lat
      longitude <- lng
      if latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    } yield {
      val city = extractString(json, "city").getOrElse("")
      val region = extractString(json, "region")
        .orElse(extractString(json, "regionName"))
        .getOrElse("")
      val country = extractString(json, "country_name")
        .orElse(extractString(json, "country"))
        .getOrElse("")
      val ip = extractString(json, "ip")
        .orElse(extractString(json, "query"))
        .getOrElse("")
      val label = Seq(city, region, country).filter(_.nonEmpty).mkString(", ")
      val accuracy = extractNumber(json, "accuracy_radius").map(_.toInt).getOrElse(50_000)
      GeoLocation(
        latitude,
        longitude,
        "ip-geolocation",
        if (label.nonEmpty) s"$label${if (ip.nonEmpty) s" / $ip" else ""}" else url,
        accuracy
      )
    }
  }

  private def firebaseLocation(): Option[GeoLocation] = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) return None
    val nodePath = s"${firebaseUrl.stripSuffix("/")}/${deviceId}.json${authSuffixQuery()}"
    try {
      val request = HttpRequest
        .newBuilder(URI.create(nodePath))
        .header("Accept", "application/json")
        .GET()
        .build()
      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() < 200 || response.statusCode() >= 300) return None
      extractPosition(response.body())
    } catch {
      case _: Exception => None
    }
  }

  private def extractPosition(json: String): Option[GeoLocation] = {
    for {
      lat <- extractNumber(json, "lat")
      lng <- extractNumber(json, "lng")
      if lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    } yield GeoLocation(lat, lng, "firebase-cache", "last Firebase position", 50_000)
  }

  private def env(name: String, fallback: String): String = {
    val value = System.getenv(name)
    if (value == null || value.trim.isEmpty) fallback else value.trim
  }

  private def envInt(name: String, fallback: Int): Int =
    try env(name, fallback.toString).toInt
    catch { case _: NumberFormatException => fallback }

  private def envDouble(name: String, fallback: Double): Double =
    try env(name, fallback.toString).toDouble
    catch { case _: NumberFormatException => fallback }

  private def envDoubleOpt(name: String): Option[Double] = {
    val value = System.getenv(name)
    if (value == null || value.trim.isEmpty) None else parseDouble(value.trim)
  }

  private def extractNumber(json: String, key: String): Option[Double] = {
    val pattern = (""""""" + java.util.regex.Pattern.quote(key) + """"\s*:\s*(-?\d+(?:\.\d+)?)""").r
    pattern.findFirstMatchIn(json).flatMap(m => parseDouble(m.group(1)))
  }

  private def extractString(json: String, key: String): Option[String] = {
    val pattern = (""""""" + java.util.regex.Pattern.quote(key) + """"\s*:\s*"([^"]*)"""").r
    pattern.findFirstMatchIn(json).map(m => unescapeJsonString(m.group(1))).filter(_.nonEmpty)
  }

  private def parseDouble(value: String): Option[Double] =
    try Some(value.toDouble)
    catch { case _: NumberFormatException => None }

  private def unescapeJsonString(value: String): String =
    value
      .replace("\\\"", "\"")
      .replace("\\/", "/")
      .replace("\\n", "\n")
      .replace("\\r", "\r")
      .replace("\\t", "\t")

  private def escapeJson(value: String): String =
    value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t")
}
