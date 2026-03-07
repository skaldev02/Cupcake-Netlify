# Trigger a k6 test run on Railway (new deployment).
# Prerequisites: Railway CLI installed, logged in, project linked (railway link).
# Usage: .\trigger-railway-test.ps1

Set-Location $PSScriptRoot
railway up
