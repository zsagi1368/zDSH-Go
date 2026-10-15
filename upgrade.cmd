@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\upgrade.ps1" %*
