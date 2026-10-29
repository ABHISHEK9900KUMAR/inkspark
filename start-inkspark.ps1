# INKSPARK launcher: installs dependencies (first run), then starts the app.
Set-Location -Path $PSScriptRoot
$Host.UI.RawUI.WindowTitle = "INKSPARK server"

Write-Host ""
Write-Host "  INKSPARK - starting up" -ForegroundColor Yellow
Write-Host "  Folder: $PSScriptRoot"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "  Node.js is not installed. Install the LTS version from https://nodejs.org, then run this again." -ForegroundColor Red
  return
}
Write-Host "  Node $(node -v) found"

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "  Created .env (demo mode). Add a free GROQ_API_KEY (or GEMINI_API_KEY) there for real poems."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "  Installing packages (first run only)..."
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host "  npm install failed." -ForegroundColor Red; return }
}

Write-Host ""
Write-Host "  Opening http://localhost:3000 ... (close this window or press Ctrl+C to stop)" -ForegroundColor Green
Start-Job -ScriptBlock { Start-Sleep -Seconds 3; Start-Process "http://localhost:3000" } | Out-Null
npm run dev
