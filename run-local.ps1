# Build and run k6 locally (Docker). Uses .env if present (production settings).
Set-Location $PSScriptRoot

docker build -t k6-railway .
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$envArgs = @()
if (Test-Path .env) {
  Get-Content .env | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#')) {
      $eq = $line.IndexOf('=')
      if ($eq -gt 0) {
        $key = $line.Substring(0, $eq).Trim()
        $val = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
        $envArgs += '-e', "${key}=${val}"
      }
    }
  }
  Write-Host "Using .env (production settings)."
} else {
  Write-Host "No .env found. Using defaults. Copy .env.example to .env for BASE_URL, TARGET_VUS, etc."
}

docker run --rm @envArgs k6-railway
