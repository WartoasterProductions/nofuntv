$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")

$PORT = 5000
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FilmsDir = Join-Path $RootDir "films"

function Get-DefaultFilmFile {
    if (-not (Test-Path $FilmsDir)) { return $null }
    $exts = @("*.mp4", "*.mkv", "*.avi", "*.mov", "*.ts", "*.webm", "*.flv", "*.m2ts", "*.wmv")
    $files = foreach ($ext in $exts) {
        Get-ChildItem -Path $FilmsDir -Filter $ext -File -ErrorAction SilentlyContinue
    }
    return $files | Sort-Object Name | Select-Object -First 1
}

function Find-PiIp {
    param([string]$PreferredIp)

    if ($PreferredIp) { return $PreferredIp }

    $known = @("10.0.0.48", "10.0.0.82")
    foreach ($ip in $known) {
        try {
            $r = Invoke-RestMethod -Uri ("http://{0}:80/api/health" -f $ip) -TimeoutSec 1 -ErrorAction Stop
            if ($r.ok) { return $ip }
        } catch {}
    }

    $local = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -notlike "127.*" }

    foreach ($addr in $local) {
        $parts = $addr.IPAddress.Split('.')
        if ($parts.Count -ne 4) { continue }
        $prefix = "{0}.{1}.{2}" -f $parts[0], $parts[1], $parts[2]
        foreach ($host in 1..254) {
            $ip = "$prefix.$host"
            try {
                $r = Invoke-RestMethod -Uri ("http://{0}:80/api/health" -f $ip) -TimeoutSec 1 -ErrorAction Stop
                if ($r.ok) { return $ip }
            } catch {}
        }
    }

    return $null
}

$FILE = $args[0]
if (-not $FILE) {
    $defaultFilm = Get-DefaultFilmFile
    if (-not $defaultFilm) {
        Write-Error "No film file found under $FilmsDir"
        exit 1
    }
    $FILE = $defaultFilm.FullName
}

if (-not (Test-Path $FILE)) {
    Write-Error "File not found: $FILE"
    exit 1
}

$PI_IP = Find-PiIp -PreferredIp $args[1]
if (-not $PI_IP) {
    Write-Error "Could not discover Pi via /api/health. Pass IP as second argument."
    exit 1
}

Write-Host "[stream] Sending $FILE -> rtp://${PI_IP}:${PORT} (720x480 NTSC)" -ForegroundColor Cyan

ffmpeg -re -stream_loop -1 -i $FILE `
    -an `
    -vf "scale=720:480:force_original_aspect_ratio=decrease,pad=720:480:(ow-iw)/2:(oh-ih)/2,setsar=1" `
    -c:v libx264 -preset ultrafast -tune zerolatency `
    -b:v 1500k -maxrate 1500k -bufsize 3000k `
    -g 30 -keyint_min 30 `
    -bsf:v h264_mp4toannexb `
    -payload_type 96 `
    -f rtp "rtp://${PI_IP}:${PORT}"
