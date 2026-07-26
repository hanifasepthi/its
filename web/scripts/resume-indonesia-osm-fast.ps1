param([int]$SubConnections = 4)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$directory = [System.IO.Path]::GetFullPath((Join-Path $root ".map-dynamics-ingest/pbf"))
$sourceUrl = "https://download.geofabrik.de/asia/indonesia-260721.osm.pbf"
$expectedBytes = [int64]1728516073
$partCount = 16
$chunkSize = [int64][math]::Ceiling($expectedBytes / $partCount)
$subConnections = [math]::Max(2, [math]::Min(8, $SubConnections))

# Stop only curl processes created for this exact Geofabrik snapshot.
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq "curl.exe" -and $_.CommandLine -like "*$sourceUrl*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

$downloads = @()
$pending = @()
for ($index = 0; $index -lt $partCount; $index += 1) {
  $partStart = [int64]($index * $chunkSize)
  $partEnd = [int64][math]::Min($expectedBytes - 1, (($index + 1) * $chunkSize) - 1)
  $partPath = Join-Path $directory ("indonesia.part{0:D2}" -f $index)
  $existing = if (Test-Path -LiteralPath $partPath) { (Get-Item -LiteralPath $partPath).Length } else { 0 }
  $expectedPartLength = $partEnd - $partStart + 1
  if ($existing -gt $expectedPartLength) { throw "Part $index is larger than expected." }
  $remaining = $expectedPartLength - $existing
  if ($remaining -eq 0) { continue }
  $subSize = [int64][math]::Ceiling($remaining / $subConnections)
  for ($sub = 0; $sub -lt $subConnections; $sub += 1) {
    $start = $partStart + $existing + ($sub * $subSize)
    if ($start -gt $partEnd) { continue }
    $end = [int64][math]::Min($partEnd, $start + $subSize - 1)
    $target = "$partPath.resume$($sub.ToString('D2'))"
    $process = Start-Process -FilePath "curl.exe" -ArgumentList @(
      "-L", "--fail", "--retry", "5", "--silent", "--show-error",
      "--range", "$start-$end", "--output", $target, $sourceUrl
    ) -WindowStyle Hidden -PassThru
    $downloads += $process
    $pending += [pscustomobject]@{ Part = $partPath; Sub = $sub; Path = $target; Process = $process }
  }
}
$downloads | Wait-Process
$failed = @($downloads | Where-Object { $_.ExitCode -ne 0 })
if ($failed.Count) { throw "Parallel resume failed for process IDs: $($failed.Id -join ', ')" }

$pending | Group-Object Part | ForEach-Object {
  $stream = [System.IO.File]::Open($_.Name, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write)
  try {
    $_.Group | Sort-Object Sub | ForEach-Object {
      $input = [System.IO.File]::OpenRead($_.Path)
      try { $input.CopyTo($stream) } finally { $input.Dispose() }
      Remove-Item -LiteralPath $_.Path -Force
    }
  } finally { $stream.Dispose() }
}

$output = Join-Path $directory "indonesia-260721.osm.pbf"
$combined = [System.IO.File]::Open($output, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  for ($index = 0; $index -lt $partCount; $index += 1) {
    $part = Join-Path $directory ("indonesia.part{0:D2}" -f $index)
    $input = [System.IO.File]::OpenRead($part)
    try { $input.CopyTo($combined) } finally { $input.Dispose() }
  }
} finally { $combined.Dispose() }
if ((Get-Item -LiteralPath $output).Length -ne $expectedBytes) { throw "Combined PBF has an unexpected size." }

$md5File = Join-Path $directory "indonesia-260721.osm.pbf.md5"
curl.exe -L --fail --silent --show-error --output $md5File "$sourceUrl.md5"
$expectedMd5 = ((Get-Content -Raw $md5File).Trim() -split '\s+')[0].ToLowerInvariant()
$actualMd5 = (Get-FileHash -Algorithm MD5 -LiteralPath $output).Hash.ToLowerInvariant()
if ($expectedMd5 -ne $actualMd5) { throw "PBF checksum mismatch." }
Write-Output ([pscustomobject]@{ path = $output; bytes = $expectedBytes; md5 = $actualMd5 } | ConvertTo-Json)
