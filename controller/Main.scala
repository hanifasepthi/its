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
import scala.util.parsing.json.JSON

object ItsController {
  private val offlineAfterMs = math.max(60_000, envInt("ITS_OFFLINE_AFTER_MS", 60_000))
  private val staleDeleteAfterMs = math.max(offlineAfterMs, envInt("ITS_STALE_DELETE_AFTER_MS", 60_000).toLong)
  private val deviceId = env("ITS_DEVICE_ID", "raspberry-its")
  private val label = env("ITS_DEVICE_LABEL", "Raspberry Pi 5 Controller")
  private val status = env("ITS_STATUS", "online")
  private val note = env("ITS_NOTE", "controller aktif")
  private val latitude = envDouble("ITS_LATITUDE", -7.280734)
  private val longitude = envDouble("ITS_LONGITUDE", 112.794963)
  private val intervalSeconds = math.max(5, envInt("ITS_INTERVAL_SECONDS", 15))
  private val outputPath = env("ITS_OUTPUT_PATH", "../web/public/data/its-state.json")
  private val firebaseUrl = env(
    "ITS_FIREBASE_BASE_URL",
    "https://itstelkom-default-rtdb.asia-southeast1.firebasedatabase.app/devices"
  )
  private val firebaseAuth = env("ITS_FIREBASE_AUTH", "")
  private val firebaseEnabled = env("ITS_FIREBASE_ENABLED", "true").toLowerCase(Locale.ROOT) != "false"
  private val httpClient = HttpClient.newHttpClient()
  private val lastSeenFormatter = DateTimeFormatter
    .ofPattern("EEEE, dd MMMM yyyy HH:mm:ss")
    .withLocale(new Locale("id", "ID"))
    .withZone(ZoneId.systemDefault())

  def main(args: Array[String]): Unit = {
    println(s"ITS controller started for $deviceId -> $outputPath")
    if (args.contains("--once")) {
      writeSnapshot()
      return
    }

    while (true) {
      writeSnapshot()
      Thread.sleep(intervalSeconds * 1000L)
    }
  }

  private def writeSnapshot(): Unit = {
    val json = buildSnapshotJson()
    val path = Paths.get(outputPath)
    val parent = path.getParent
    if (parent != null) {
      Files.createDirectories(parent)
    }

    Files.writeString(
      path,
      json,
      StandardCharsets.UTF_8,
      StandardOpenOption.CREATE,
      StandardOpenOption.TRUNCATE_EXISTING,
      StandardOpenOption.WRITE
    )

    println(s"[${java.time.LocalDateTime.now()}] wrote ${path.toAbsolutePath}")
    publishFirebaseSnapshot(json)
    cleanupStaleNonRaspberryNodes()
  }

  private def buildSnapshotJson(): String = {
    val lastSeen = System.currentTimeMillis()
    val updatedAt = lastSeen
    val lastSeenText = lastSeenFormatter.format(Instant.ofEpochMilli(lastSeen))
    val deviceJson = s"""{"id":"${escapeJson(deviceId)}","label":"${escapeJson(label)}","status":"${escapeJson(status)}","lastSeen":$lastSeen,"lastSeenText":"${escapeJson(lastSeenText)}","note":"${escapeJson(note)}","position":{"lat":$latitude,"lng":$longitude}}"""
    s"""{"updatedAt":$updatedAt,"source":"scala-controller","devices":[${deviceJson}]}"""
  }

  private def cleanupStaleNonRaspberryNodes(): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) {
      return
    }

    try {
      val request = HttpRequest
        .newBuilder(URI.create(firebaseJsonUrl(firebaseUrl)))
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

  private def firebaseJsonUrl(base: String): String = {
    s"${base.stripSuffix("/")}.json" +
      (if (firebaseAuth.trim.isEmpty) "" else s"?auth=${URLEncoder.encode(firebaseAuth.trim, StandardCharsets.UTF_8)}")
  }

  private def deleteDeviceNode(id: String): Unit = {
    val deleteUrl = s"${firebaseUrl.stripSuffix("/")}/${id}.json" +
      (if (firebaseAuth.trim.isEmpty) "" else s"?auth=${URLEncoder.encode(firebaseAuth.trim, StandardCharsets.UTF_8)}")

    try {
      val request = HttpRequest
        .newBuilder(URI.create(deleteUrl))
        .DELETE()
        .build()

      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() >= 200 && response.statusCode() < 300) {
        println(s"[${java.time.LocalDateTime.now()}] deleted stale node $id from Firebase RTDB")
      } else {
        println(s"[${java.time.LocalDateTime.now()}] Firebase delete failed for $id: HTTP ${response.statusCode()}")
      }
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Firebase delete error for $id: ${ex.getMessage}")
    }
  }

  private def extractStaleDeviceIds(json: String, staleAfterMs: Long): Seq[String] = {
    val cutoff = System.currentTimeMillis() - staleAfterMs
    JSON.parseFull(json) match {
      case Some(root: Map[_, _]) =>
        root.collect {
          case (deviceId: String, deviceValue: Map[_, _]) =>
            val lastSeen = deviceValue.get("lastSeen") match {
              case Some(value: Double) => value.toLong
              case Some(value: Int) => value.toLong
              case Some(value: Long) => value
              case Some(value: String) =>
                try value.toLong
                catch {
                  case _: NumberFormatException => 0L
                }
              case _ => 0L
            }

            if (lastSeen > 0 && lastSeen < cutoff) Some(deviceId) else None
        }.flatten.toSeq
      case _ => Seq.empty
    }
  }

  private def publishFirebaseSnapshot(json: String): Unit = {
    if (!firebaseEnabled || firebaseUrl.trim.isEmpty) {
      return
    }

    try {
      val devicePath = s"${firebaseUrl.stripSuffix("/")}/${deviceId}.json" +
        (if (firebaseAuth.trim.isEmpty) "" else s"?auth=${URLEncoder.encode(firebaseAuth.trim, StandardCharsets.UTF_8)}")
      val request = HttpRequest
        .newBuilder(URI.create(devicePath))
        .header("Content-Type", "application/json")
        .PUT(HttpRequest.BodyPublishers.ofString(json))
        .build()

      val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
      if (response.statusCode() >= 200 && response.statusCode() < 300) {
        println(s"[${java.time.LocalDateTime.now()}] published snapshot to Firebase RTDB")
      } else {
        println(s"[${java.time.LocalDateTime.now()}] Firebase publish failed: HTTP ${response.statusCode()}")
      }
    } catch {
      case ex: Exception =>
        println(s"[${java.time.LocalDateTime.now()}] Firebase publish error: ${ex.getMessage}")
    }
  }

  private def env(name: String, fallback: String): String = {
    val value = System.getenv(name)
    if (value == null || value.trim.isEmpty) fallback else value.trim
  }

  private def envInt(name: String, fallback: Int): Int = {
    try {
      env(name, fallback.toString).toInt
    } catch {
      case _: NumberFormatException => fallback
    }
  }

  private def envDouble(name: String, fallback: Double): Double = {
    try {
      env(name, fallback.toString).toDouble
    } catch {
      case _: NumberFormatException => fallback
    }
  }

  private def escapeJson(value: String): String = {
    value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t")
  }
}
