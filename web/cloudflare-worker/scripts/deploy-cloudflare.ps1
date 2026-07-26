[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FirebaseServiceAccountPath,
  [string]$VapidPublicKey = $env:ITS_FIREBASE_VAPID_PUBLIC_KEY,
  [string]$PushAdminToken = $env:ITS_PUSH_ADMIN_TOKEN,
  [string]$ControllerWebhookSecret = $env:ITS_CONTROLLER_WEBHOOK_SECRET,
  [switch]$SkipKnowledgeSetup
)

$ErrorActionPreference = "Stop"
$workerRoot = Split-Path -Parent $PSScriptRoot
$credentialPath = (Resolve-Path -LiteralPath $FirebaseServiceAccountPath).Path
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  throw "Firebase service-account file tidak ditemukan."
}

function Read-SecretText([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Test-NativeProbe([scriptblock]$Command) {
  try {
    & $Command *> $null
    return $LASTEXITCODE -eq 0
  }
  catch {
    return $false
  }
}

if (-not $PushAdminToken) {
  $PushAdminToken = Read-SecretText "Masukkan PUSH_ADMIN_TOKEN (minimal 32 karakter)"
}
if ($PushAdminToken.Length -lt 32) {
  throw "PUSH_ADMIN_TOKEN minimal 32 karakter."
}
if (-not $ControllerWebhookSecret) {
  $ControllerWebhookSecret = Read-SecretText "Masukkan CONTROLLER_WEBHOOK_SECRET (minimal 32 karakter)"
}
if ($ControllerWebhookSecret.Length -lt 32) {
  throw "CONTROLLER_WEBHOOK_SECRET minimal 32 karakter."
}
if (-not $VapidPublicKey) {
  $VapidPublicKey = Read-Host -Prompt "Masukkan public VAPID key Firebase (boleh kosong untuk default key)"
}

$secretEnvironmentNames = @(
  "ITS_FIREBASE_VAPID_PUBLIC_KEY",
  "ITS_PUSH_ADMIN_TOKEN",
  "ITS_CONTROLLER_WEBHOOK_SECRET",
  "CLOUDFLARE_API_TOKEN"
)
$secretEnvironmentBackup = @{}
foreach ($name in $secretEnvironmentNames) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ($null -ne $value) {
    $secretEnvironmentBackup[$name] = $value
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
}

Push-Location $workerRoot
try {
  # Dependency lifecycle scripts do not need access to deployment credentials.
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install gagal." }

  if ($secretEnvironmentBackup.ContainsKey("CLOUDFLARE_API_TOKEN")) {
    [Environment]::SetEnvironmentVariable(
      "CLOUDFLARE_API_TOKEN",
      $secretEnvironmentBackup["CLOUDFLARE_API_TOKEN"],
      "Process"
    )
  }

  npx wrangler whoami
  if ($LASTEXITCODE -ne 0) {
    throw "Wrangler belum login. Jalankan 'npx wrangler login' atau set CLOUDFLARE_API_TOKEN."
  }

  if (-not (Test-NativeProbe { npx wrangler vectorize get its-maps-knowledge })) {
    npx wrangler vectorize create its-maps-knowledge --dimensions=1024 --metric=cosine
    if ($LASTEXITCODE -ne 0) { throw "Pembuatan Vectorize index gagal." }
  }

  foreach ($queueName in @("its-maps-push-delivery", "its-maps-push-dead-letter")) {
    if (-not (Test-NativeProbe { npx wrangler queues info $queueName })) {
      npx wrangler queues create $queueName
      if ($LASTEXITCODE -ne 0) { throw "Pembuatan Queue $queueName gagal." }
    }
  }

  npm run check
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare Worker check gagal." }

  npx wrangler deployments list
  npx wrangler deploy
  if ($LASTEXITCODE -ne 0) { throw "Cloudflare Worker deploy gagal." }

  $firebaseJson = Get-Content -Raw -LiteralPath $credentialPath
  $firebaseJson | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON
  if ($LASTEXITCODE -ne 0) { throw "Secret FIREBASE_SERVICE_ACCOUNT_JSON gagal disimpan." }
  $PushAdminToken | npx wrangler secret put PUSH_ADMIN_TOKEN
  if ($LASTEXITCODE -ne 0) { throw "Secret PUSH_ADMIN_TOKEN gagal disimpan." }
  $ControllerWebhookSecret | npx wrangler secret put CONTROLLER_WEBHOOK_SECRET
  if ($LASTEXITCODE -ne 0) { throw "Secret CONTROLLER_WEBHOOK_SECRET gagal disimpan." }
  if ($VapidPublicKey) {
    $VapidPublicKey | npx wrangler secret put FIREBASE_VAPID_PUBLIC_KEY
    if ($LASTEXITCODE -ne 0) { throw "FIREBASE_VAPID_PUBLIC_KEY gagal disimpan." }
  }

  $health = Invoke-RestMethod -Uri "https://its.hanifahseptiani45.workers.dev/v1/health" -Method Get
  if (-not $health.ok) { throw "Health check Worker gagal." }

  if (-not $SkipKnowledgeSetup) {
    $headers = @{ Authorization = "Bearer $PushAdminToken" }
    foreach ($knowledgeUrl in @(
      "https://itstelkom.web.app/llms.txt",
      "https://itstelkom.web.app/llms-full.txt"
    )) {
      $body = @{ urls = @($knowledgeUrl) } | ConvertTo-Json -Depth 4
      Invoke-RestMethod `
        -Uri "https://its.hanifahseptiani45.workers.dev/v1/admin/knowledge/setup" `
        -Method Post `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body | Out-Null
    }
  }

  Write-Host "Cloudflare ITS Maps siap: https://its.hanifahseptiani45.workers.dev/v1/health"
  Write-Host "AI Gateway 'default' akan dibuat otomatis oleh Cloudflare pada inference pertama."
}
finally {
  foreach ($name in $secretEnvironmentNames) {
    $value = if ($secretEnvironmentBackup.ContainsKey($name)) { $secretEnvironmentBackup[$name] } else { $null }
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
  Pop-Location
}
