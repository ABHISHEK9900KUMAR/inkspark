@echo off
REM Double-click to run INKSPARK in PowerShell
start "INKSPARK server" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%~dp0start-inkspark.ps1"
