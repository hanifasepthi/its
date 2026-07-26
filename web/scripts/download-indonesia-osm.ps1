param(
  [string]$OutputDirectory = ".map-dynamics-ingest/pbf",
  [int]$Connections = 16
)

$ErrorActionPreference = "Stop"
$sourceUrl = "https://download.geofabrik.de/asia/indonesia-260721.osm.pbf"
$expectedBytes = [int64]1728516073
$expectedMd5Url = "$sourceUrl.md5"
$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
$workspace = [System.IO.Path]::GetFullPath((Get-Location).Path)
if (-not $resolvedOutput.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Output directory must stay inside the workspace."
}
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

$connections = [math]::Max(1, [math]::Min(32, $Connections))
$chunkSize = [int64][math]::Ceiling($expectedBytes / $connections)
$processes = @()
for ($index = 0; $index -lt $connections; $index += 1) {
  $start = [int64]($index * $chunkSize)
  $end = [int64][math]::Min($expectedBytes - 1, (($index + 1) * $chunkSize) - 1)
  $target = Join-Path $resolvedOutput ("indonesia.part{0:D2}" -f $index)
  $processes += Start-Process -FilePath "curl.exe" -ArgumentList @(
    "-L", "--fail", "--retry", "5", "--silent", "--show-error",
    "--range", "$start-$end", "--output", $target, $sourceUrl
  ) -WindowStyle Hidden -PassThru
}
$processes | Wait-Process
$failed = @($processes | Where-Object { $_.ExitCode -ne 0 })
if ($failed.Count) { throw "Parallel download failed for process IDs: $($failed.Id -join ', ')" }

$output = Join-Path $resolvedOutput "indonesia-260721.osm.pbf"
$stream = [System.IO.File]::Open($output, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
try {
  for ($index = 0; $index -lt $connections; $index += 1) {
    $part = Join-Path $resolvedOutput ("indonesia.part{0:D2}" -f $index)
    $input = [System.IO.File]::OpenRead($part)
    try { $input.CopyTo($stream) } finally { $input.Dispose() }
  }
} finally { $stream.Dispose() }

if ((Get-Item -LiteralPath $output).Length -ne $expectedBytes) {
  throw "Combined PBF has an unexpected size."
}
$md5File = Join-Path $resolvedOutput "indonesia-260721.osm.pbf.md5"
curl.exe -L --fail --silent --show-error --output $md5File $expectedMd5Url
$expectedMd5 = ((Get-Content -Raw $md5File).Trim() -split '\s+')[0].ToLowerInvariant()
$actualMd5 = (Get-FileHash -Algorithm MD5 -LiteralPath $output).Hash.ToLowerInvariant()
if ($expectedMd5 -ne $actualMd5) { throw "PBF checksum mismatch." }

for ($index = 0; $index -lt $connections; $index += 1) {
  Remove-Item -LiteralPath (Join-Path $resolvedOutput ("indonesia.part{0:D2}" -f $index)) -Force
}
Write-Output ([pscustomobject]@{ path = $output; bytes = $expectedBytes; md5 = $actualMd5 } | ConvertTo-Json)
