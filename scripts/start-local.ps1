$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $portableNode = Join-Path $projectRoot '.local-tools\node-v24.19.0-win-x64'
    if (Test-Path (Join-Path $portableNode 'node.exe')) {
        $env:Path = "$portableNode;$env:Path"
    } else {
        throw '未找到 Node.js 24。请安装 Node.js LTS 后重新运行。'
    }
}

if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
    npm.cmd install
}

npm.cmd run dev
