# Static file server for Deal Angle Radar dashboard.
# No refresh loop, no git operations.
# Usage: powershell -ExecutionPolicy Bypass -File .\serve.ps1 [-Port 8878]
param([int]$Port = 8878)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Deal Angle Radar: http://localhost:$Port/ (root: $root)"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
        $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
        if ($rel -eq '/') { $rel = '/index.html' }
        $path = Join-Path $root ($rel -replace '/', '\')
        $full = [System.IO.Path]::GetFullPath($path)
        if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'traversal' }
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $res.StatusCode = 200
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
        }
    } catch {
        try { $res.StatusCode = 500 } catch {}
    } finally {
        try { $res.OutputStream.Close() } catch {}
    }
}
