' Silent launcher (no console window). Double-click, or pin/shortcut this file.
' The server writes its own log to data\server.log (so launching twice is safe).
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Environment("Process")("EXITAI_AUTOEXIT") = "1"
sh.Run "cmd /c node server.mjs --app", 0, False
