use serde_json::{json, Value};

#[cfg(windows)]
pub fn inspect(trim: bool) -> Result<Value, String> {
    use std::{collections::HashSet, mem::{size_of, zeroed}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            ProcessStatus::{K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
            SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, PROCESS_SET_QUOTA},
        },
    };
    unsafe {
        let mut system: MEMORYSTATUSEX = zeroed();
        system.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut system) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        let mut owned = HashSet::from([std::process::id()]);
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error().to_string()); }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut children = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("msedgewebview2.exe") {
                children.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        loop {
            let before = owned.len();
            for (pid, parent) in &children { if owned.contains(parent) { owned.insert(*pid); } }
            if owned.len() == before { break; }
        }
        let mut before = 0u64;
        let mut after = 0u64;
        let mut measured = 0;
        let mut trimmed = 0;
        for pid in owned {
            let rights = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | if trim { PROCESS_SET_QUOTA } else { 0 };
            let process = OpenProcess(rights, 0, pid);
            if process.is_null() { continue; }
            let mut counters: PROCESS_MEMORY_COUNTERS = zeroed();
            let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            counters.cb = size;
            if K32GetProcessMemoryInfo(process, &mut counters, size) != 0 {
                measured += 1;
                before += counters.WorkingSetSize as u64;
                if trim && K32EmptyWorkingSet(process) != 0 { trimmed += 1; }
                let _ = K32GetProcessMemoryInfo(process, &mut counters, size);
                after += counters.WorkingSetSize as u64;
            }
            CloseHandle(process);
        }
        if trim && trimmed == 0 { return Err("暂时无法整理桌宠内存，请稍后重试".into()); }
        Ok(json!({"total":system.ullTotalPhys,"available":system.ullAvailPhys,
            "used":system.ullTotalPhys.saturating_sub(system.ullAvailPhys),"percent":system.dwMemoryLoad,
            "appWorkingSet":after,"processCount":measured,"trimmed":trimmed,
            "reducedWorkingSet":before.saturating_sub(after)}))
    }
}

#[cfg(not(windows))]
pub fn inspect(_trim: bool) -> Result<Value, String> { Err("当前内存查看仅支持 Windows".into()) }
