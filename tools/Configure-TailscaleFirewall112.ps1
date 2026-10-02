# Run elevated after the owner approves the setup. Only the game ports on the
# Tailscale interface are allowed; the deploy/control API stays local.
[CmdletBinding()]
param([string]$ResultFile)
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'Local112Config.ps1')
    $config = Resolve-Local112Config -RequireGameDirectory
    $ports = Get-Local112Ports $config
    $tail = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    $address = (& $tail ip -4 | Select-Object -First 1).Trim()
    if ($address -notmatch '^100\.(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 64 -or [int]$Matches[1] -gt 127) {
        throw 'Connect the host to Tailscale first.'
    }
    $adapter = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $address
    $node = (Get-Command node.exe).Source
    $game = Join-Path $config.GameDirectory 'Dauntless-Win64-Shipping.exe'
    foreach ($entry in @(
        @{ Name='Undaunted112-Tailscale-TCP'; Label='Undaunted 1.12 Tailscale TCP'; Protocol='TCP'; Ports=@($ports.Metagame,$ports.Xmpp); Program=$node },
        @{ Name='Undaunted112-Tailscale-UDP'; Label='Undaunted 1.12 Tailscale worlds'; Protocol='UDP'; Ports=@("$($ports.WorldFirst)-$($ports.WorldLast)"); Program=$game }
    )) {
        $existing = Get-NetFirewallRule -Name $entry.Name -ErrorAction SilentlyContinue
        if ($existing) {
            $existing | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -InterfaceAlias $adapter.InterfaceAlias -Program $entry.Program
            $existing | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -LocalAddress $address -RemoteAddress '100.64.0.0/10'
            $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol $entry.Protocol -LocalPort $entry.Ports
        } else {
            New-NetFirewallRule -Name $entry.Name -DisplayName $entry.Label -Group 'Undaunted 1.12 Tailscale' `
                -Enabled True -Direction Inbound -Action Allow -Profile Any -InterfaceAlias $adapter.InterfaceAlias `
                -Program $entry.Program -Protocol $entry.Protocol -LocalPort $entry.Ports `
                -LocalAddress $address -RemoteAddress '100.64.0.0/10' | Out-Null
        }
    }
    $result = @{ success=$true; hostAddress=$address; tcpPorts=@($ports.Metagame,$ports.Xmpp); udpPorts="$($ports.WorldFirst)-$($ports.WorldLast)" }
    if ($ResultFile) { $result | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    Write-Output 'Tailscale firewall rules installed for the game ports only.'
} catch {
    if ($ResultFile) { @{ success=$false; message=$_.Exception.Message } | ConvertTo-Json | Set-Content -LiteralPath $ResultFile -Encoding UTF8 }
    throw
}
