import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Paths
import java.nio.file.StandardOpenOption

object ItsController {
  private val deviceId = env("ITS_DEVICE_ID", "raspberry-its")
  private val label = env("ITS_DEVICE_LABEL", "Raspberry Pi 5 Controller")
  private val status = env("ITS_STATUS", "online")
  private val note = env("ITS_NOTE", "controller aktif")
  private val latitude = envDouble("ITS_LATITUDE", -7.280734)
  private val longitude = envDouble("ITS_LONGITUDE", 112.794963)
  private val intervalSeconds = math.max(5, envInt("ITS_INTERVAL_SECONDS", 15))
  private val outputPath = env("ITS_OUTPUT_PATH", "../web/public/data/its-state.json")

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
  }

  private def buildSnapshotJson(): String = {
    val lastSeen = System.currentTimeMillis()
    val updatedAt = lastSeen
    val deviceJson = s"""{"id":"${escapeJson(deviceId)}","label":"${escapeJson(label)}","status":"${escapeJson(status)}","lastSeen":$lastSeen,"note":"${escapeJson(note)}","position":{"lat":$latitude,"lng":$longitude}}"""
    s"""{"updatedAt":$updatedAt,"source":"scala-controller","devices":[${deviceJson}]}"""
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
