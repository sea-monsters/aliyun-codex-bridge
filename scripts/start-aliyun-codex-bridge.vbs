Option Explicit

' Windows autostart launcher for aliyun-codex-bridge
' Usage:
'   wscript scripts\start-aliyun-codex-bridge.vbs [host] [port] [ai_base] [log_level]
' Example:
'   wscript scripts\start-aliyun-codex-bridge.vbs 127.0.0.1 31415 https://coding.dashscope.aliyuncs.com/v1 info

Const DEFAULT_HOST = "127.0.0.1"
Const DEFAULT_PORT = "4000"
Const DEFAULT_LOG_LEVEL = "info"

Dim shell, fso, args
Dim host, port, aiBase, logLevel
Dim scriptPath, scriptsDir, repoDir, logsDir, logFile
Dim checkCmd, startCmd, rc, aiBasePart

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

host = DEFAULT_HOST
port = DEFAULT_PORT
aiBase = ""
logLevel = DEFAULT_LOG_LEVEL

If args.Count >= 1 Then host = args(0)
If args.Count >= 2 Then port = args(1)
If args.Count >= 3 Then aiBase = args(2)
If args.Count >= 4 Then logLevel = args(3)

scriptPath = WScript.ScriptFullName
scriptsDir = fso.GetParentFolderName(scriptPath)
repoDir = fso.GetParentFolderName(scriptsDir)

logsDir = repoDir & "\logs"
If Not fso.FolderExists(logsDir) Then
  fso.CreateFolder logsDir
End If
logFile = logsDir & "\bridge.log"

' If port already listening, skip startup.
checkCmd = "powershell -NoProfile -ExecutionPolicy Bypass -Command " & Q("$p=" & port & "; if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }")
rc = shell.Run(checkCmd, 0, True)
If rc = 0 Then
  WScript.Quit 0
End If

aiBasePart = ""
If Len(aiBase) > 0 Then
  aiBasePart = " && set " & Q("AI_BASE=" & aiBase)
End If

startCmd = "cmd.exe /c " & Q( _
  "cd /d " & Q(repoDir) & _
  " && set " & Q("HOST=" & host) & _
  " && set " & Q("PORT=" & port) & _
  aiBasePart & _
  " && set " & Q("LOG_LEVEL=" & logLevel) & _
  " && node src\server.js >> " & Q(logFile) & " 2>&1")

' Hidden window, do not wait
shell.Run startCmd, 0, False
WScript.Quit 0

Function Q(ByVal s)
  Q = Chr(34) & s & Chr(34)
End Function
