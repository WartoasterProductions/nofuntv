@echo off
cd /d "%~dp0gst-frontend"
if not exist node_modules (
    echo Installing dependencies...
    npm install
)
npm start
