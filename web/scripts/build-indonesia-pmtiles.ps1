param(
  [string]$PbfPath = ".map-dynamics-ingest/pbf/indonesia-260721.osm.pbf",
  [string]$OutputPath = ".map-dynamics-ingest/tiles/indonesia.pmtiles"
)

$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
$pbf = [System.IO.Path]::GetFullPath((Join-Path $root $PbfPath))
$output = [System.IO.Path]::GetFullPath((Join-Path $root $OutputPath))
$workspace = [System.IO.Path]::GetFullPath($root)
foreach ($target in @($pbf, $output)) {
  if (-not $target.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Input and output must stay inside the workspace."
  }
}
if (-not (Test-Path -LiteralPath $pbf -PathType Leaf)) { throw "Indonesia PBF is missing: $pbf" }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($output)) | Out-Null

$osmium = Join-Path $root ".tools/osmium/Library/bin/osmium.exe"
$planetiler = Join-Path $root ".tools/planetiler/planetiler.jar"
if (-not (Test-Path -LiteralPath $osmium)) { throw "Osmium is not installed." }
if (-not (Test-Path -LiteralPath $planetiler)) { throw "Planetiler is not installed." }

$infoPath = Join-Path ([System.IO.Path]::GetDirectoryName($output)) "indonesia-osm-fileinfo.json"
& $osmium fileinfo -e -j $pbf | Set-Content -LiteralPath $infoPath -Encoding UTF8
if ($LASTEXITCODE -ne 0) { throw "osmium fileinfo failed." }

$sources = Join-Path $root ".map-dynamics-ingest/planetiler/sources"
$temporary = Join-Path $root ".map-dynamics-ingest/planetiler/tmp"
[System.IO.Directory]::CreateDirectory($sources) | Out-Null
[System.IO.Directory]::CreateDirectory($temporary) | Out-Null

& java -Xmx8g -jar $planetiler `
  --osm-path=$pbf `
  --output=$output `
  --download `
  --download-dir=$sources `
  --tmpdir=$temporary `
  --force `
  --threads=8 `
  --maxzoom=15 `
  --languages=id,en `
  --building-merge-z13=false `
  --output-layerstats=true
if ($LASTEXITCODE -ne 0) { throw "Planetiler build failed." }

$fileInfo = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json
$nodes = [int64]$fileInfo.data.count.nodes
$ways = [int64]$fileInfo.data.count.ways
$relations = [int64]$fileInfo.data.count.relations
$records = $nodes + $ways + $relations
if ($records -lt 100000000) {
  throw "The verified source contains only $records records; the >100 million requirement is not met."
}
$archive = Get-Item -LiteralPath $output
$catalog = [ordered]@{
  schemaVersion = "1.0"
  dataset = "its-maps-indonesia-national-vector"
  status = "ready"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  source = [ordered]@{
    name = "OpenStreetMap Indonesia extract by Geofabrik"
    snapshot = "2026-07-21"
    url = "https://download.geofabrik.de/asia/indonesia-260721.osm.pbf"
    license = "ODbL-1.0"
    attribution = "© OpenStreetMap contributors"
    nodes = $nodes
    ways = $ways
    relations = $relations
    sourceRecordCount = $records
    pbfBytes = (Get-Item -LiteralPath $pbf).Length
    pbfSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $pbf).Hash.ToLowerInvariant()
  }
  archive = [ordered]@{
    format = "PMTiles"
    tileType = "MVT"
    minZoom = 0
    maxZoom = 15
    bytes = $archive.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $output).Hash.ToLowerInvariant()
    url = "https://its.hanifahseptiani45.workers.dev/v1/map/archive/indonesia.pmtiles"
    downloadUrl = "https://github.com/hanifasepthi/its/releases/download/map-data-2026-07-21/indonesia.pmtiles"
  }
  coverage = [ordered]@{
    country = "ID"
    bbox = @(94.5, -11.5, 141.1, 6.5)
    linked = $true
  }
}
$catalogPath = Join-Path $root "public/data/national-map.json"
$catalog | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $catalogPath -Encoding UTF8
Write-Output ($catalog | ConvertTo-Json -Depth 8)
