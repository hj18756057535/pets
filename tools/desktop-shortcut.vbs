Option Explicit
Dim shell, files, folder, shortcut
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
If Not files.FileExists(folder & "\PetDesk.exe") Then
  MsgBox "Extract the complete ZIP first, then run this file beside PetDesk.exe.", 48, "PetDesk"
  WScript.Quit 1
End If
Set shortcut = shell.CreateShortcut(shell.SpecialFolders("Desktop") & "\PetDesk.lnk")
shortcut.TargetPath = folder & "\PetDesk.exe"
shortcut.WorkingDirectory = folder
shortcut.IconLocation = folder & "\PetDesk.exe,0"
shortcut.Description = "PetDesk desktop companion"
shortcut.Save
MsgBox "PetDesk shortcut created on your desktop.", 64, "PetDesk"
