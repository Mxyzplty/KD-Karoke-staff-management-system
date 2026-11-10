# SPDX-License-Identifier: AGPL-3.0-only
# Own-work isolated spoken words for CT-11. Generated PCM stays in the supplied scratch directory.
# powershell -NoProfile -File tests/ui/t09-acoustic-fixture.ps1 -Destination <epic-scratch>/t09-acoustic
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[System.IO.Directory]::CreateDirectory($Destination) | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice('Microsoft David Desktop')
  $synth.Rate = 0
  $synth.Volume = 100
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  foreach ($word in @('one','eight')) {
    $synth.SetOutputToWaveFile((Join-Path $Destination "$word.wav"), $format)
    $synth.Speak($word)
    $synth.SetOutputToNull()
    Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Destination "$word.wav")
  }
} finally { $synth.Dispose() }
