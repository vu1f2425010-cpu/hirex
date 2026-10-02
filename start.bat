@echo off
title HIREX AI Interview Platform
echo ========================================================
echo   HIREX - Simple AI Interview Platform (Python Server)
echo ========================================================
echo.
echo Running at http://localhost:5000
echo.

if exist "C:\Users\shyam\python_env\python.exe" (
    "C:\Users\shyam\python_env\python.exe" server.py
) else (
    python server.py
)

pause
