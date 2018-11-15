---
layout:     post
title:      "WoW64 internals"
subtitle:   ...re-discovering Heaven's Gate on ARM
date:       2018-11-04 16:00:00 +0200
background: '/img/bg-post.jpg'
---

WoW64 - aka Windows (32-bit) on Windows (64-bit) - is a subsystem that enables
32-bit Windows applications to run on 64-bit Windows. Most people today are
familiar with WoW64 on Windows **x64**, where they can run **x86** applications.
WoW64 has been with us since Windows XP, and x64 wasn't the only architecture
where WoW64 has been available - it was available on **IA-64** architecture as
well, where WoW64 has been responsible for emulating x86. Newly, WoW64 is also
available on **ARM64**, enabling emulation of both **x86** and **ARM32**
appllications.

[MSDN offers brief article][msdn-wow64-details] on WoW64 implementation details.
We can find that WoW64 consists of (ignoring IA-64):
- Translation support DLLs:
    - `wow64.dll`: translation of `Nt*` system calls (`ntoskrnl.exe` / `ntdll.dll`)
    - `wow64win.dll`: translation of `NtGdi*`, `NtUser*` and other GUI-related
      system calls (`win32k.sys` / `win32u.dll`)
- Emulation support DLLs:
    - `wow64cpu.dll`: support for running x86 programs on x64
    - `wowarmhw.dll`: support for running ARM32 programs on ARM64
    - `xtajit.dll`: support for running x86 programs on ARM64

Besides `Nt*` system call translation, the `wow64.dll` provides the core
emulation infrastructure.

If you have previous experience with reversing WoW64 on x64, you can notice
that it shares plenty of common code with WoW64 subsystem on ARM64. Especially
if you peeked into WoW64 of recent x64 Windows, you may have noticed that it
actually contains strings such as `SysArm32` and that some functions check
against `IMAGE_FILE_MACHINE_ARMNT (0x1C4)` machine type:

{% include image.html
   src="/img/posts/2/IDA_Wow64SelectSystem32PathInternal.png"
   alt="Wow64SelectSystem32PathInternal"
   caption="Wow64SelectSystem32PathInternal found in wow64.dll on Windows x64"
%}

{% include image.html
   src="/img/posts/2/IDA_Wow64ArchGetSP.png"
   alt="Wow64ArchGetSP"
   caption="Wow64ArchGetSP found in wow64.dll on Windows x64"
%}

WoW on x64 systems cannot emulate ARM32 though - it just apparently shares
common code. But `SysX8664` and `SysArm64` sound particularly interesting!

Those similarities can help anyone who is fluent in x86/x64, but not that much
in ARM. Also, HexRays decompiler produce much better output for x86/x64 than
for ARM32/ARM64.

Initially, my purpose with this blogpost was to get you familiar with how WoW64
works for ARM32 programs on ARM64. But because WoW64 itself changed a lot with
Windows 10, and because WoW64 shares some similarities between x64 and ARM64,
I decided to briefly get you through how WoW64 works in general.

Everything presented in this article is based on Windows 10 - insider preview,
build 18247.

## Table of contents

- [Terms](#terms)
- [Kernel](#kernel)
    - [Kernel (initialization)](#kernel-initialization)
    - [Kernel (create process)](#kernel-create-process)
- [Initialization of the WoW64 process](#initialization-of-the-wow64-process)
    - [`wow64!ProcessInit`](#wow64processinit)
        - [`wow64!ServiceTables`](#wow64servicetables)
        - [`wow64!Wow64SystemServiceEx`](#wow64wow64systemserviceex)
    - [`wow64!ProcessInit` (cont.)](#wow64processinit-cont)
    - [`wow64!ThreadInit`](#wow64threadinit)
- [x86 on x64](#x86-on-x64)
    - [Entering 32-bit mode](#entering-32-bit-mode)
    - [Leaving 32-bit mode](#leaving-32-bit-mode)
    - [Turbo thunks](#turbo-thunks)
    - [Disabling Turbo thunks](#disabling-turbo-thunks)
- [x86 on ARM64](#x86-on-arm64)
    - [`Windows\SyCHPE32` & `Windows\SysWOW64`](#windowssychpe32--windowssyswow64)
- [ARM32 on ARM64](#arm32-on-arm64)
    - [`nt!KiEnter32BitMode` / `SVC 0xFFFF`](#ntkienter32bitmode--svc-0xffff)
    - [`nt!KiExit32BitMode` / `UND #0xF8`](#ntkiexit32bitmode--und-0xf8)
- [Appendix](#appendix)


## Terms

Througout this article I'll be using some terms I'd like to explain beforehand:
- `ntdll` or `ntdll.dll` - these will be always refering to the native `ntdll.dll` (x64 on Windows x64, ARM64
  on Windows ARM64, ...), until said otherwise or until the context wouldn't indicate otherwise.
- `ntdll32` or `ntdll32.dll` - to make an easy distinction between native and
  WoW64 `ntdll.dll`, **any** WoW64 `ntdll.dll` will be refered with the `*32` suffix.
- `emu` or `emu.dll` - these will represent any of the emulation support DLLs (one of `wow64cpu.dll`,
  `wowarmhw.dll`, `xtajit.dll`)
- `module!FunctionName` - refers to a symbol `FunctionName` within the `module`.
  If you're familiar with WinDbg, you're already familiar with this notation.
- `CHPE` - "compiled-hybrid-PE", a new type of PE file, which looks as if it was x86
  PE file, but has ARM64 code within them. `CHPE` will be tackled in more detail
  in the [x86 on ARM64](#x86-on-arm64) section.
- The terms **emulation** and **binary-translation** refer to the WoW64 workings
  and they may be used interchangeably.

## Kernel

This section shows some points of interest in the `ntoskrnl.exe` regarding to
the WoW64 initialization. If you're interested only in the user-mode part of
the WoW64, you can skip this part to the
[Initialization of the WoW64 process](#initialization-of-the-wow64-process).

### Kernel (initialization)

Initalization of WoW64 begins with the initialization of the kernel:

- `nt!KiSystemStartup`
- `nt!KiInitializeKernel`
- `nt!InitBootProcessor`
- `nt!PspInitPhase0`
- `nt!Phase1Initialization`
    - `nt!IoInitSystem`
        - `nt!IoInitSystemPreDrivers`
        - `nt!PsLocateSystemDlls`

`nt!PsLocateSystemDlls` routine takes a pointer named `nt!PspSystemDlls`,
and then calls `nt!PspLocateSystemDll` in a loop. Let's figure out what's
going on here:

{% include image.html
   src="/img/posts/2/IDA_PspSystemDlls_x64.png"
   alt="PspSystemDlls (x64)"
   caption="PspSystemDlls (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_PspSystemDlls_ARM64.png"
   alt="PspSystemDlls (ARM64)"
   caption="PspSystemDlls (ARM64)"
%}

`nt!PspSystemDlls` appears to be array of pointers to some structure, which
holds some NTDLL-related data. The order of these NTDLLs corresponds with
this `enum` (included in the **PDB**):

<script src="https://gist.github.com/wbenny/0fe3f22d272f59536ecded10e3fdbbbf.js"></script>

Now, let's look how such structure looks like:

{% include image.html
   src="/img/posts/2/IDA_SystemDllData_x64.png"
   alt="SystemDllData (x64)"
   caption="SystemDllData (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_SystemDllData_ARM64.png"
   alt="SystemDllData (ARM64)"
   caption="SystemDllData (ARM64)"
%}

The `nt!PspLocateSystemDll` function intializes fields of this structure. The
layout of this structure isn't unfortunatelly in the **PDB**, but you can
find a reconstructed version in the [appendix](#appendix).

Now let's get back to the `nt!Phase1Initialization` - there's more:

- `...`
- `nt!Phase1Initialization`
    - `nt!Phase1InitializationIoReady`
        - `nt!PspInitPhase2`
        - `nt!PspInitializeSystemDlls`

`nt!PspInitializeSystemDlls` routine takes a pointer named `nt!NtdllExportInformation`.
Let's look at it:

{% include image.html
   src="/img/posts/2/IDA_NtdllExportInformation_x64.png"
   alt="NtdllExportInformation (x64)"
   caption="NtdllExportInformation (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_NtdllExportInformation_ARM64.png"
   alt="NtdllExportInformation (ARM64)"
   caption="NtdllExportInformation (ARM64)"
%}

It looks like it's some sort of array, again, ordered by the `enum _SYSTEM_DLL_TYPE`.
Let's examine `NtdllExports`:

{% include image.html
   src="/img/posts/2/IDA_NtdllExports_x64.png"
   alt="NtdllExportInformation (x64)"
   caption="NtdllExportInformation (x64)"
%}

Nothing unexpected - just tuples of **function name** and **function pointer**.
Did you notice the difference in the number after the `NtdllExports` field? On x64
there is **19** meanwhile on ARM64 there is **14**. This number represents number
of items in `NtdllExports` - and indeed, there is slightly different set of them:

|                 x64                      |                ARM64                     |
|------------------------------------------|------------------------------------------|
|  (0) `LdrInitializeThunk`                |  (0) `LdrInitializeThunk`                |
|  (1) `RtlUserThreadStart`                |  (1) `RtlUserThreadStart`                |
|  (2) `KiUserExceptionDispatcher`         |  (2) `KiUserExceptionDispatcher`         |
|  (3) `KiUserApcDispatcher`               |  (3) `KiUserApcDispatcher`               |
|  (4) `KiUserCallbackDispatcher`          |  (4) `KiUserCallbackDispatcher`          |
|                    -                     |  (5) `KiUserCallbackDispatcherReturn`    |
|  (5) `KiRaiseUserExceptionDispatcher`    |  (6) `KiRaiseUserExceptionDispatcher`    |
|  (6) `RtlpExecuteUmsThread`              |                    -                     |
|  (7) `RtlpUmsThreadYield`                |                    -                     |
|  (8) `RtlpUmsExecuteYieldThreadEnd`      |                    -                     |
|  (9) `ExpInterlockedPopEntrySListEnd`    |  (7) `ExpInterlockedPopEntrySListEnd`    |
| (10) `ExpInterlockedPopEntrySListFault`  |  (8) `ExpInterlockedPopEntrySListFault`  |
| (11) `ExpInterlockedPopEntrySListResume` |  (9) `ExpInterlockedPopEntrySListResume` |
| (12) `LdrSystemDllInitBlock`             | (10) `LdrSystemDllInitBlock`             |
| (13) `RtlpFreezeTimeBias`                | (11) `RtlpFreezeTimeBias`                |
| (14) `KiUserInvertedFunctionTable`       | (12) `KiUserInvertedFunctionTable`       |
| (15) `WerReportExceptionWorker`          | (13) `WerReportExceptionWorker`          |
| (16) `RtlCallEnclaveReturn`              |                    -                     |
| (17) `RtlEnclaveCallDispatch`            |                    -                     |
| (18) `RtlEnclaveCallDispatchReturn`      |                    -                     |
|-------------------------------------------------------------------------------------|

We can see that ARM64 is missing `Ums` ([User-Mode Scheduling][msdn-ums]) and
[`Enclave`][msdn-createenclave] functions. Also, we can see that ARM64 has one
extra function: `KiUserCallbackDispatcherReturn`.

On the other hand, all `NtdllWow*Exports` contain the same set of function names:

{% include image.html
   src="/img/posts/2/IDA_NtdllWowExports_ARM64.png"
   alt="NtdllWowExports (ARM64)"
   caption="NtdllWowExports (ARM64)"
%}

Notice names of second fields of these "structures": `PsWowX86SharedInformation`,
`PsWowChpeX86SharedInformation`, ... If we look at the address of those fields,
we can see that they're part of another array:

{% include image.html
   src="/img/posts/2/IDA_PsWowX86SharedInformation_ARM64.png"
   alt="PsWowX86SharedInformation (ARM64)"
   caption="PsWowX86SharedInformation (ARM64)"
%}

Those addresses are actually **targets** of the pointers in the `NtdllWow*Exports`
structure. Also, those functions combined with `PsWow*SharedInformation` might
give you hint that they're related to this `enum` (included in the **PDB**):

<script src="https://gist.github.com/wbenny/fbf9799034e7a561fbcb23623f828586.js"></script>

Notice how the order of the `SharedNtdll32BaseAddress` corellates with the empty field in
the previous screenshot (highlighted). The set of WoW64 NTDLL functions is same
on both x64 and ARM64.

(The C representation of this data can be found in the [appendix](#appendix).)

Now we can tell what the `nt!PspInitializeSystemDlls` function does - it gets
**image base** of each NTDLL (`nt!PsQuerySystemDllInfo`), resolves all
`Ntdll*Exports` for them (`nt!RtlFindExportedRoutineByName`). Also, only for
all WoW64 NTDLLs (`if ((SYSTEM_DLL_TYPE)SystemDllType > PsNativeSystemDll)`)
it assigns the **image base** to the `SharedNtdll32BaseAddress` field of the
`PsWow*SharedInformation` array (`nt!PspWow64GetSharedInformation`).

### Kernel (create process)

Let's talk briefly about process creation. As you probably already know, the
native `ntdll.dll` is mapped as a first DLL into each created process. This
applies for all architectures - **x86**, **x64** and also for **ARM64**.
The WoW64 processes aren't exception to this rule - the WoW64 processes share
the same initialization code path as native processes.

- `nt!NtCreateUserProcess`
- `nt!PspAllocateProcess`
    - `nt!PspSetupUserProcessAddressSpace`
        - `nt!PspPrepareSystemDllInitBlock`
        - `nt!PspWow64SetupUserProcessAddressSpace`
- `nt!PspAllocateThread`
    - `nt!PspWow64InitThread`
    - `nt!KeInitThread // Entry-point: nt!PspUserThreadStartup`

- `nt!PspUserThreadStartup`
- `nt!PspInitializeThunkContext`
    - `nt!KiDispatchException`

If you ever wondered how is the first user-mode instruction of the newly created
process executed, now you know the answer - a "synthetic" user-mode exception
is dispatched, with `ExceptionRecord.ExceptionAddress = &PspLoaderInitRoutine`,
where `PspLoaderInitRoutine` points to the `ntdll!LdrInitializeThunk`.
This is the first function that is executed in every process - including WoW64
processes.

## Initialization of the WoW64 process

The fun part begins!

> **NOTE:** Initialization of the `wow64.dll` is same on both x64 and ARM64.
> Eventual differences will be mentioned.

- `ntdll!LdrInitializeThunk`
- `ntdll!LdrpInitialize`
- `ntdll!_LdrpInitialize`
- `ntdll!LdrpInitializeProcess`
- `ntdll!LdrpLoadWow64`

The `ntdll!LdrpLoadWow64` function is called when the `ntdll!UseWOW64` global variable is `TRUE`,
which is set when `NtCurrentTeb()->WowTebOffset != NULL`.

It constructs the full path to the `wow64.dll`, loads it, and then resolves
following functions:
- `Wow64LdrpInitialize`
- `Wow64PrepareForException`
- `Wow64ApcRoutine`
- `Wow64PrepareForDebuggerAttach`
- `Wow64SuspendLocalThread`

> **NOTE:** The resolution of these pointers is wrapped between pair of
> `ntdll!LdrProtectMrdata` calls, responsible for protecting (1) and
> unprotecting (0) the `.mrdata` section - in which these pointers reside.
> `MRDATA` (Mutable Read Only Data) are part of the CFG (Control-Flow Guard)
> functionality. You can look at [Alex's slides][alex-mrdata] for more
> information.

When these functions are successfully located, the `ntdll.dll` finally
transfers control to the `wow64.dll` by calling `wow64!Wow64LdrpInitialize`.
Let's go through the sequence of calls that eventually bring us to the entry-point
of the "emulated" application.

- `wow64!Wow64LdrpInitialize`
    - `wow64!Wow64InfoPtr = (NtCurrentPeb32() + 1)`
    - `NtCurrentTeb()->TlsSlots[/* 10 */ WOW64_TLS_WOW64INFO] = wow64!Wow64InfoPtr`
    - `ntdll!RtlWow64GetCpuAreaInfo`
    - `wow64!ProcessInit`
    - `wow64!CpuNotifyMapViewOfSection // Process image`
    - `wow64!Wow64DetectMachineTypeInternal`
    - `wow64!Wow64SelectSystem32PathInternal`
    - `wow64!CpuNotifyMapViewOfSection // 32-bit NTDLL image`
    - `wow64!ThreadInit`
    - `wow64!ThunkStartupContext64TO32`
    - `wow64!Wow64SetupInitialCall`
    - `wow64!RunCpuSimulation`
        - `emu!BTCpuSimulate`

`Wow64InfoPtr` is the first initialized variable in the `wow64.dll`. It contains
data shared between 32-bit and 64-bit execution mode and its structure is not
documented, although you can find this structure partialy restored in the [appendix](#appendix).

`RtlWow64GetCpuAreaInfo` is an internal `ntdll.dll` function which is called a lot
during emulation. It is mainly used for fetching the machine type and architecture-specific
CPU context (the `CONTEXT` structure) of the emulated process. This information is fetched into an undocumented
structure, which we'll be calling `WOW64_CPU_AREA_INFO`. Pointer to this structure
is then given to the `ProcessInit` function.

`Wow64DetectMachineTypeInternal` determines the machine type of the executed
process and returns it. `Wow64SelectSystem32PathInternal` selects the "emulated"
`System32` directory based on that machine type, e.g. `SysWOW64` for x86 processes
or `SysArm32` for ARM32 processes.

You can also notice calls to `CpuNotifyMapViewOfSection` function. As the name
suggests, it is also called on each "emulated" call of `NtMapViewOfSection`.
This function:
- Checks if the mapped image is executable
- Checks if following conditions are true:
    - `NtHeaders->OptionalHeader.MajorSubsystemVersion == USER_SHARED_DATA.NtMajorVersion`
    - `NtHeaders->OptionalHeader.MinorSubsystemVersion == USER_SHARED_DATA.NtMinorVersion`

If these checks pass, `CpupResolveReverseImports` function is called. This function
checks if the mapped image exports the `Wow64Transition` symbol and if so, it
assigns there a **32-bit pointer value** returned by `emu!BTCpuGetBopCode`.

The `Wow64Transition` is mostly known to be exported by `SysWOW64\ntdll.dll`,
but there are actually multiple of Windows' WoW DLLs which exports this symbol.
You might be already familiar with the term "Heaven's Gate" -
this is where the `Wow64Transition` will point to on Windows x64 - a simple far
jump instruction which switches into long-mode (64-bit) enabled code segment.
On ARM64, the `Wow64Transition` points to a "nop" function.

> **NOTE:** Because there are no checks on the `ImageName`, the `Wow64Transition`
> symbol is resolved for all executable images that passes the checks mentioned
> earlier. If you're wondering whether `Wow64Transition` would be resolved for
> your custom executable or DLL - it indeed would!

The initialization then continues with thread-specific initialization by
calling `ThreadInit`. This is followed by pair of calls
`ThunkStartupContext64TO32(CpuArea.MachineType, CpuArea.Context, NativeContext)`
and `Wow64SetupInitialCall(&CpuArea)` - these functions perform the necessary
setup of the architecture-specific WoW64 `CONTEXT` structure to prepare start
of the execution in the emulated environment. This is done in the exact same
way as if `ntoskrnl.exe` would actually executed the emulated application - i.e.:
- setting the instruction pointer to the address of `ntdll32!LdrInitializeThunk`
- setting the stack pointer below the WoW64 `CONTEXT` structure
- setting the 1st parameter to point to that `CONTEXT` structure
- setting the 2nd parameter to point to the base address of the `ntdll32`

Finally, the `RunCpuSimulation` function is called. This function just
calls `BTCpuSimulate` from the binary-translator DLL, which contains the
actual emulation loop that never returns.

### `wow64!ProcessInit`

- `wow64!Wow64ProtectMrdata // 0`
- `wow64!Wow64pLoadLogDll`
    - `ntdll!LdrLoadDll // "%SystemRoot%\system32\wow64log.dll"`

`wow64.dll` has also it's own `.mrdata` section and `ProcessInit` begins with
unprotecting it. It then tries to load the `wow64log.dll` from the constructed
system directory. Note that this DLL is never present in any released Windows
installation (it's probably used internally by Microsoft for debugging of the
WoW64 subsystem). Therefore, load of this DLL will normally fail. This isn't
problem, though, because no critical functionality of the WoW64 subsystem
depends on it. If the load would actually succeed, the `wow64.dll` would try
to find following exported functions there:

- `Wow64LogInitialize`
- `Wow64LogSystemService`
- `Wow64LogMessageArgList`
- `Wow64LogTerminate`

If any of these functions wouldn't be exported, the DLL would be immediately
unloaded.

If we'd drop custom `wow64log.dll` (which would export functions mentioned above)
into the `%SystemRoot%\System32` directory, it would actually get loaded into
every WoW64 process. This way we could drop a custom logging DLL, or even inject
every WoW64 process with native DLL!

For more details, you can check my [injdrv][injdrv] project which implements
injection of native DLLs into WoW64 processes, or check [this post by Walied Assar][wow64log].

Then, certain important values are fetched from the `LdrSystemDllInitBlock` array.
These contains base address of the `ntdll32.dll`, pointer to functions like
`ntdll32!KiUserExceptionDispatcher`, `ntdll32!KiUserApcDispatcher`, ...,
control flow guard information and others.

Finally, the `Wow64pInitializeFilePathRedirection` is called, which - as the name
suggests - initializes WoW64 path redirection. The path redirection is completely
implemented in the `wow64.dll` and the mechanism is basically based on string
replacement. The path redirection can be disabled and enabled by calling
`kernel32!Wow64DisableWow64FsRedirection` & `kernel32!Wow64RevertWow64FsRedirection`
function pairs. Both of these functions internally call `ntdll32!RtlWow64EnableFsRedirectionEx`,
which directly operates on `NtCurrentTeb()->TlsSlots[/* 8 */ WOW64_TLS_FILESYSREDIR]` field.

#### `wow64!ServiceTables`

Next, a `ServiceTables` array is initialized. You might be already familiar
with the `KSERVICE_TABLE_DESCRIPTOR` from the `ntoskrnl.exe`, which contains - among
other things - a pointer to an array of system functions callable from the user-mode.
`ntoskrnl.exe` contains 2 of these tables: one for `ntoskrnl.exe` itself and one
for the `win32k.sys`, aka the Windows (GUI) subsystem. `wow64.dll` has 4 of them!

The `WOW64_SERVICE_TABLE_DESCRIPTOR` has the exact same structure as the `KSERVICE_TABLE_DESCRIPTOR`,
except that it is extended:

<script src="https://gist.github.com/wbenny/b14d8a9a4a3281cb1aab283e56ae41e3.js"></script>

(More detailed definition of this structure is in the [appendix](#appendix).)

`ServiceTables` array is populated as follows:
- `ServiceTables[/* 0 */ WOW64_NTDLL_SERVICE_INDEX] = sdwhnt32`
- `ServiceTables[/* 1 */ WOW64_WIN32U_SERVICE_INDEX] = wow64win!sdwhwin32`
- `ServiceTables[/* 2 */ WOW64_KERNEL32_SERVICE_INDEX = wow64win!sdwhcon`
- `ServiceTables[/* 3 */ WOW64_USER32_SERVICE_INDEX] = sdwhbase`

> **NOTE:** `wow64.dll` directly depends (by import table) on two DLLs:
> the native `ntdll.dll` and `wow64win.dll`. This means that `wow64win.dll` is
> loaded even into "non-Windows-subsystem" processes, that wouldn't normally
> load `user32.dll`.
> 
> These two symbols mentioned above are the only symbols that `wow64.dll` requires
> `wow64win.dll` to export.

Let's have a look at `sdwhnt32` service table:

{% include image.html
   src="/img/posts/2/IDA_sdwhnt32_x64.png"
   alt="sdwhnt32 (x64)"
   caption="sdwhnt32 (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_sdwhnt32JumpTable_x64.png"
   alt="sdwhnt32JumpTable (x64)"
   caption="sdwhnt32JumpTable (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_sdwhnt32Number_x64.png"
   alt="sdwhnt32Number (x64)"
   caption="sdwhnt32Number (x64)"
%}

There is nothing surprising for those who already dealt with service tables in `ntoskrnl.exe`.
`sdwhnt32JumpTable` contains array of the system call functions, which are
traditionaly prefixed. WoW64 "system calls" are prefixed with `wh*`, which
honestly I don't have any idea what it stands for - although it might be the
case as with `Zw*` prefix - it stands for nothing and is simply used as an
unique distinguisher.

The job of these `wh*` functions is to correctly convert any arguments and
return values from the 32-bit version to the native, 64-bit version. Keep in
mind that that it not only includes conversion of integers and pointers, but
also content of the structures. Interesting note might be that each of the
`wh*` functions has only one argument, which is pointer to an array of 32-bit
values. This array contains the parameters passed to the 32-bit system call.

As you could notice, in those 4 service tables there are "system calls" that
are not present in the `ntoskrnl.exe`. Also, I mentioned earlier that the
`Wow64Transition` is resolved in multiple DLLs. Currently, these DLLs export
this symbol:
- `ntdll.dll`
- `win32u.dll`
- `kernel32.dll` and `kernelbase.dll`
- `user32.dll`

The `ntdll.dll` and `win32u.dll` are obvious and they represent the same thing
as their native counterparts. The service tables used by `kernel32.dll` and
`user32.dll` contain functions for transformation of particular `csrss.exe` calls
into their 64-bit version.

It's also worth noting that at the end of the `ntdll.dll` system table, there
are several functions with `NtWow64*` calls, such as `NtWow64ReadVirtualMemory64`,
`NtWow64WriteVirtualMemory64` and others. These are special functions which are
provided only to WoW64 processes.

One of these special functions is also `NtWow64CallFunction64`. It has it's own
small dispatch table and callers can select which function should be called
based on its index:

{% include image.html
   src="/img/posts/2/IDA_Wow64FunctionDispatch64_x64.png"
   alt="Wow64FunctionDispatch64 (x64)"
   caption="Wow64FunctionDispatch64 (x64)"
%}

> **NOTE:** I'll be talking about one of these functions - namely `Wow64CallFunctionTurboThunkControl` -
> later in the [Disabling Turbo thunks](#disabling-turbo-thunks) section.

#### `wow64!Wow64SystemServiceEx`

This function is similar to the kernel's `nt!KiSystemCall64` - it does the
dispatching of the system call. This function is exported by the `wow64.dll`
and imported by the emulation DLLs. `Wow64SystemServiceEx` accepts 2 arguments:
- The system call number
- Pointer to an array of 32-bit arguments passed to the system call (mentioned earlier)

The system call number isn't just an index, but also contains index of a system
table which needs to be selected (this is also true for `ntoskrnl.exe`):

<script src="https://gist.github.com/wbenny/7b3db2cd56f13c65f6b6fc21681055fe.js"></script>

This function then selects `ServiceTables[ServiceTableIndex]` and calls the
appropriate `wh*` function based on the `SystemCallNumber`.

{% include image.html
   src="/img/posts/2/IDA_Wow64SystemServiceEx_x64.png"
   alt="Wow64SystemServiceEx (x64)"
   caption="Wow64SystemServiceEx (x64)"
%}

> **NOTE:** In case the `wow64log.dll` has been successfully loaded, the `Wow64SystemServiceEx`
> function calls `Wow64LogSystemServiceWrapper` (wrapper around `wow64log!Wow64LogSystemService`
> function): once before the actual system call and one immediately after. This
> can be used for instrumentation of each WoW64 system call! The structure
> passed to `Wow64LogSystemService` contains every important information about
> the system call - it's table index, system call number, the argument list and
> on the second call, even the resulting `NTSTATUS`! You can find layout of
> this structure in the [appendix](#appendix) (`WOW64_LOG_SERVICE`).

Finally, as have been mentioned, the `WOW64_SERVICE_TABLE_DESCRIPTOR` structure
differs from `KSERVICE_TABLE_DESCRIPTOR` in that it contains `ErrorCase` table.
The code mentioned above is actually wrapped in a **SEH** `__try`/`__except`
block. If `whService` raise an exception, the `__except` block calls
`Wow64HandleSystemServiceError` function. The function looks if the corresponding
service table which raised the exception has non-`NULL` `ErrorCase` and if it does,
it selects the appropriate `WOW64_ERROR_CASE` for the system call. If the `ErrorCase`
is `NULL`, the values from `ErrorCaseDefault` are used. The `NTSTATUS` of the
exception is then transformed according to an algorithm which can be found in the [appendix](#appendix).

### `wow64!ProcessInit` (cont.)

- `...`
- `wow64!CpuLoadBinaryTranslator // MachineType`
    - `wow64!CpuGetBinaryTranslatorPath // MachineType`
        - `ntdll!NtOpenKey // "\Registry\Machine\Software\Microsoft\Wow64\"`
        - `ntdll!NtQueryValueKey // "arm" / "x86"`
        - `ntdll!RtlGetNtSystemRoot // "arm" / "x86"`
        - `ntdll!RtlUnicodeStringPrintf // "%ws\system32\%ws"`

As you've probably guessed, this function constructs path to the **binary-translator DLL**,
which is - on x64 - known as `wow64cpu.dll`. This DLL will be responsible for
the actual low-level emulation.

{% include image.html
   src="/img/posts/2/Win_Wow64_Registry_x86_x64.png"
   alt="\Registry\Machine\Software\Microsoft\Wow64\x86 (x64)"
   caption="\Registry\Machine\Software\Microsoft\Wow64\x86 (x64)"
%}

{% include image.html
   src="/img/posts/2/Win_Wow64_Registry_arm_ARM64.png"
   alt="\Registry\Machine\Software\Microsoft\Wow64\arm (ARM64)"
   caption="\Registry\Machine\Software\Microsoft\Wow64\arm (ARM64)"
%}

{% include image.html
   src="/img/posts/2/Win_Wow64_Registry_x86_ARM64.png"
   alt="\Registry\Machine\Software\Microsoft\Wow64\x86 (ARM64)"
   caption="\Registry\Machine\Software\Microsoft\Wow64\x86 (ARM64)"
%}

We can see that there is no `wow64cpu.dll` on ARM64. Instead, there is `xtajit.dll`
used for x86 emulation and `wowarmhw.dll` used for ARM32 emulation.

> **NOTE:** The `CpuGetBinaryTranslatorPath` function is same on both x64 and
> ARM64 except for one peculiar difference:
> on Windows x64, if the `\Registry\Machine\Software\Microsoft\Wow64\x86` key cannot
> be opened (is missing/was deleted), the function **contains a fallback** to load
> `wow64cpu.dll`. On Windows ARM64, though, it **doesn't have such fallback** and if
> the registry key is missing, the function fails and the **WoW64 process is terminated**.

`wow64.dll` then loads one of the selected DLL and tries to find there following
exported functions:

|                                           |                                   |
|-------------------------------------------|-----------------------------------|
| `BTCpuProcessInit` **(!)**                | `BTCpuProcessTerm`                |
| `BTCpuThreadInit`                         | `BTCpuThreadTerm`                 |
| `BTCpuSimulate` **(!)**                   | `BTCpuResetFloatingPoint`         |
| `BTCpuResetToConsistentState`             | `BTCpuNotifyDllLoad`              |
| `BTCpuNotifyDllUnload`                    | `BTCpuPrepareForDebuggerAttach`   |
| `BTCpuNotifyBeforeFork`                   | `BTCpuNotifyAfterFork`            |
| `BTCpuNotifyAffinityChange`               | `BTCpuSuspendLocalThread`         |
| `BTCpuIsProcessorFeaturePresent`          | `BTCpuGetBopCode` **(!)**         |
| `BTCpuGetContext`                         | `BTCpuSetContext`                 |
| `BTCpuTurboThunkControl`                  | `BTCpuNotifyMemoryAlloc`          |
| `BTCpuNotifyMemoryFree`                   | `BTCpuNotifyMemoryProtect`        |
| `BTCpuFlushInstructionCache2`             | `BTCpuNotifyMapViewOfSection`     |
| `BTCpuNotifyUnmapViewOfSection`           | `BTCpuUpdateProcessorInformation` |
| `BTCpuNotifyReadFile`                     | `BTCpuCfgDispatchControl`         |
| `BTCpuUseChpeFile`                        | `BTCpuOptimizeChpeImportThunks`   |
| `BTCpuNotifyProcessExecuteFlagsChange`    | `BTCpuProcessDebugEvent`          |
| `BTCpuFlushInstructionCacheHeavy`         |                                   |


Interestingly, not all functions need to be found - only those marked with the
"**(!)**", the rest is optional. As a next step, the resolved `BTCpuProcessInit`
function is called, which performs binary-translator-specific process initialization.

At the end of the `ProcessInit` function, `wow64!Wow64ProtectMrdata(1)` is called,
making `.mrdata` non-writable again.

### `wow64!ThreadInit`

- `wow64!ThreadInit`
    - `wow64!CpuThreadInit`
        - `NtCurrentTeb32()->WOW32Reserved = BTCpuGetBopCode()`
        - `emu!BTCpuThreadInit`

`ThreadInit` does some little thread-specific initialization, such as:

- Copying `CurrentLocale` and `IdealProcessor` values from 64-bit `TEB` into
  32-bit `TEB`.
- For non-`WOW64_CPUFLAGS_SOFTWARE` emulators, it calls `CpuThreadInit`, which:
    - Performs `NtCurrentTeb32()->WOW32Reserved = BTCpuGetBopCode()`.
    - Calls `emu!BTCpuThreadInit()`.
- For `WOW64_CPUFLAGS_SOFTWARE` emulators, it creates an event, which added into
  `AlertByThreadIdEventHashTable` and set to `NtCurrentTeb()->TlsSlots[18]`.
  This event is used for special emulation of `NtAlertThreadByThreadId` and
  `NtWaitForAlertByThreadId`.

> **NOTE:** The `WOW64_CPUFLAGS_MSFT64 (1)` or the `WOW64_CPUFLAGS_SOFTWARE (2)`
> flag is stored in the `NtCurrentTeb()->TlsSlots[/* 10 */ WOW64_TLS_WOW64INFO]`,
> in the `WOW64INFO.CpuFlags` field. One of these flags is always set in the
> emulator's `BTCpuProcessInit` function (mentioned in the section above):
> - `wow64cpu.dll` sets `WOW64_CPUFLAGS_MSFT64 (1)`
> - `wowarmhw.dll` sets `WOW64_CPUFLAGS_MSFT64 (1)`
> - `xtajit.dll` sets `WOW64_CPUFLAGS_SOFTWARE (2)`

## x86 on x64

### Entering 32-bit mode

- `...`
- `wow64!RunCpuSimulation`
    - `wow64cpu!BTCpuSimulate`
        - `wow64cpu!RunSimulatedCode`

`RunSimulatedCode` runs in a loop and performs transitions into 32-bit mode
either via:

- `jmp fword ptr[reg]` - a "far jump" that not only changes instruction pointer (`RIP`),
  but also the code segment register (`CS`). This segment usually being set to `0x23`,
  while 64-bit code segment is `0x33`
- synthetic "machine frame" and `iret` - called on every "state reset"

> **NOTE:** Explanation of segmentation and "why does it work just by changing
> a segment register" is beyond scope of this article. If you'd like to know more about
> "long mode" and segmentation, you can start [here][osdev-long-mode].

Far jump is used most of the time for the transition, mainly because it's faster.
`iret` on the other hand is more powerful, as it can change `CS`, `SS`, `EFLAGS`, `RSP` and `RIP`
all at once. The "state reset" occurs when `WOW64_CPURESERVED.Flags` has
`WOW64_CPURESERVED_FLAG_RESET_STATE (1)` bit set. This happens during exception
(see `wow64!Wow64PrepareForException` and `wow64cpu!BTCpuResetToConsistentState`).
Also, this flag is cleared on every emulation loop (using `btr` - bit-test-and-reset).

{% include image.html
   src="/img/posts/2/IDA_RunSimulatedCode_x64.png"
   alt="Start of the RunSimulatedCode (x64)"
   caption="Start of the RunSimulatedCode (x64)"
%}

You can see the simplest form of switching into the 32-bit mode. Also, at the beginning
you can see that `TurboThunkDispatch` address is moved into the `r15` register.
This register stays untouched during the whole `RunSimulatedCode` function.

### Leaving 32-bit mode

The switch back to the 64-bit mode is very similar - it also uses far jumps.
The usual situation when code wants to switch back to the 64-bit mode is upon
system call:

{% include image.html
   src="/img/posts/2/IDA_x86_NtMapViewOfSection_x64.png"
   alt="NtMapViewOfSection (x64)"
   caption="NtMapViewOfSection (x64)"
%}

The `Wow64SystemServiceCall` is just a simple jump to the `Wow64Transition`:

{% include image.html
   src="/img/posts/2/IDA_x86_Wow64SystemServiceCall_x64.png"
   alt="Wow64SystemServiceCall (x64)"
   caption="Wow64SystemServiceCall (x64)"
%}

If you remember, the `Wow64Transition` value is resolved by the `wow64cpu!BTCpuGetBopCode`
function:

{% include image.html
   src="/img/posts/2/IDA_wow64cpu_BTCpuGetBopCode_x64.png"
   alt="BTCpuGetBopCode - wow64cpu.dll (x64)"
   caption="BTCpuGetBopCode - wow64cpu.dll (x64)"
%}

It selects either `KiFastSystemCall` or `KiFastSystemCall2` based on the `CpupSystemCallFast`
value.

The `KiFastSystemCall` looks like this (used when `CpupSystemCallFast != 0`):
- `[x86] jmp 33h:$+9` (jumps to the instruction below)
- `[x64] jmp qword ptr [r15+offset]` (which points to `CpupReturnFromSimulatedCode`)

The `KiFastSystemCall2` looks like this (used when `CpupSystemCallFast == 0`):
- `[x86] push 0x33`
- `[x86] push eax`
- `[x86] call $+5`
- `[x86] pop eax`
- `[x86] add eax, 12`
- `[x86] xchg eax, dword ptr [esp]`
- `[x86] jmp fword ptr [esp]` (jumps to the instruction below)
- `[x64] add rsp, 8`
- `[x64] jmp wow64cpu!CpupReturnFromSimulatedCode`

Clearly, the `KiFastSystemCall` is faster, so why it's not used used every time?

It turns out, `CpupSystemCallFast` is set to 1 in the `wow64cpu!BTCpuProcessInit` function if
the process is not executed with the [`ProhibitDynamicCode` mitigation policy][msdn-process-mitigation-dynamic-code-policy]
and if `NtProtectVirtualMemory(&KiFastSystemCall, PAGE_READ_EXECUTE)` succeeds.

This is because `KiFastSystemCall` is in a non-executable read-only section (`W64SVC`) while
`KiFastSystemCall2` is in read-executable section (`WOW64SVC`).

But the actual reason why is `KiFastSystemCall` in non-executable section by default and needs to be
set as executable manually is, honestly, unknown to me. My guess would be that
it has something to do with relocations, because the address in the `jmp 33h:$+9`
instruction must be somehow resolved by the loader. But maybe I'm wrong. Let me know if you know the answer!

### Turbo thunks

I hope you didn't forget about the `TurboThunkDispatch` address hanging in the
`r15` register. This value is used as a jump-table:

{% include image.html
   src="/img/posts/2/IDA_TurboThunkDispatch_x64.png"
   alt="TurboThunkDispatch (x64)"
   caption="TurboThunkDispatch (x64)"
%}

There are 32 items in the jump-table.

{% include image.html
   src="/img/posts/2/IDA_TurboDispatchJumpAddressStart_x64.png"
   alt="TurboDispatchJumpAddressStart (x64)"
   caption="TurboDispatchJumpAddressStart (x64)"
%}

`CpupReturnFromSimulatedCode` is the first code that is always executed in the 64-bit
mode when 32-bit to 64-bit transition occurs. Let's recapitulate the code:

- Stack is swapped,
- Non-volatile registers are saved
- `eax` - which contains the encoded service table index and system call number - 
  is moved into the `ecx`
- it's high-word is acquired via `ecx >> 16`.
- the result is used as an index into the `TurboThunkDispatch` jump-table

You might be confused now, because few sections above we've defined the service
number like this:

<script src="https://gist.github.com/wbenny/7b3db2cd56f13c65f6b6fc21681055fe.js"></script>

...therefore, after right-shifting this value by 16 bits we should get always 0,
right?

It turns out, on x64, the `WOW64_SYSTEM_SERVICE` might be defined like this:

<script src="https://gist.github.com/wbenny/0be281c8b00f01922de9c46b307f059a.js"></script>

Let's examine few WoW64 system calls:

{% include image.html
   src="/img/posts/2/IDA_x86_NtMapViewOfSection_x64.png"
   alt="NtMapViewOfSection (x64)"
   caption="NtMapViewOfSection (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_x86_NtWaitForSingleObject_x64.png"
   alt="NtWaitForSingleObject (x64)"
   caption="NtWaitForSingleObject (x64)"
%}

{% include image.html
   src="/img/posts/2/IDA_x86_NtDeviceIoControlFile_x64.png"
   alt="NtDeviceIoControlFile (x64)"
   caption="NtDeviceIoControlFile (x64)"
%}

Based on our new definition of `WOW64_SYSTEM_SERVICE`, we can conclude that:

- `NtMapViewOfSection` uses turbo thunk with index 0 (`TurboDispatchJumpAddressEnd`)
- `NtWaitForSingleObject` uses turbo thunk with index 13 (`Thunk3ArgSpNSpNSpReloadState`)
- `NtDeviceIoControlFile` uses turbo thunk with index 27 (`DeviceIoctlFile`)

Let's finally explain "turbo thunks" in proper way.

Turbo thunks are an optimalization of WoW64 subsystem - specifically on Windows x64 -
that enables for particular system calls to never leave the `wow64cpu.dll` - the
conversion of parameters and return value, and the `syscall` instruction itself
is fully performed there. The set of functions that use these turbo thunks reveals,
that they are usually very simple in terms of parameter conversion - they receive
numerical values or handles.

The notation of `Thunk*` labels is as follows:
- The number specifies how many arguments the function receives
- `Sp` converts parameter with sign-extension
- `NSp` converts parameter without sign-extension
- `ReloadState` will return to the 32-bit mode using `iret` instead of far jump,
  if `WOW64_CPURESERVED_FLAG_RESET_STATE` is set
- `QuerySystemTime`, `ReadWriteFile`, `DeviceIoctlFile`, ... are special cases

Let's take the `NtWaitForSingleObject` and its turbo thunk `Thunk3ArgSpNSpNSpReloadState`
as an example:

- it receives 3 parameters
- 1st parameter is sign-extended
- 2nd parameter isn't sign-extended
- 3rd parameter isn't sign-extended
- it can switch to 32-bit mode using `iret` if `WOW64_CPURESERVED_FLAG_RESET_STATE` is set

When we cross-check this information with its function prototype, it makes sense:

<script src="https://gist.github.com/wbenny/056f1c57f917154416c2ebe39dd7234f.js"></script>

The sign-extension of `HANDLE` makes sense, because if we pass there an `INVALID_HANDLE_VALUE`,
which happens to be `0xFFFFFFFF (-1)` on 32-bits, we don't want to convert this value
to `0x00000000FFFFFFFF`, but `0xFFFFFFFFFFFFFFFF`.

On the other hand, if the `TurboThunkNumber` is 0, the call will end up in the
`TurboDispatchJumpAddressEnd` which in turn calls `wow64!Wow64SystemServiceEx`.
You can consider this case as the "slow path".

### Disabling Turbo thunks

On Windows x64, the Turbo thunk optimization can be actually disabled!

In one of
the previous sections I've been talking about `ntdll32!NtWow64CallFunction64` and
`wow64!Wow64CallFunctionTurboThunkControl` functions. As with any other `NtWow64*`
function, `NtWow64CallFunction64` is only available in the WoW64 `ntdll.dll`.
This function can be called with an index to WoW64 function in the
`Wow64FunctionDispatch64` table (mentioned earlier).

The function prototype might look like this:

<script src="https://gist.github.com/wbenny/9e6ddf8306d4f68b3227a040a5f07325.js"></script>

> **NOTE:** This function prototype has been reconstructed with the help of the
> `wow64!Wow64CallFunction64Nop` function code, which just logs the parameters.

We can see that `wow64!Wow64CallFunctionTurboThunkControl` can be called with an
index of 2. This function performs some sanity checks and then passes calls
`wow64cpu!BTCpuTurboThunkControl(*(ULONG*)InputBuffer)`.

`wow64cpu!BTCpuTurboThunkControl` then checks the input parameter.
- If it's 0, it patches every target of the jump table to point to
  `TurboDispatchJumpAddressEnd` (remember, this is the target that is called when
  `WOW64_SYSTEM_SERVICE.TurboThunkNumber` is 0).
- If it's non-0, it returns `STATUS_NOT_SUPPORTED`.

This means 2 things:
- Calling `wow64cpu!BTCpuTurboThunkControl(0)` disables the Turbo thunks, and
  every system call ends up taking the "slow path".
- It is not possible to enable them back.

With all this in mind, we can achieve disabling Turbo thunks by this call:

<script src="https://gist.github.com/wbenny/173891ac91cd888017faadce4460ae82.js"></script>

What it might be good for? I can think of 3 possible use-cases:

- If we deploy custom `wow64log.dll`, disabling Turbo thunks
  guarantees that we will see **every WoW64 system call** in our
  `wow64log!Wow64LogSystemService` callback. We wouldn't see such calls if the Turbo thunks
  were enabled, because they would take the "fast path" inside of the `wow64cpu.dll`
  where the `syscall` would be executed.

- If we decide to hook `Nt*` functions in the **native `ntdll.dll`**, disabling
  Turbo thunks guarantees that for each `Nt*` function called in the `ntdll32.dll`,
  the correspondint `Nt*` function will be called in the native `ntdll.dll`.
  (This is basically the same point as the previous one.)

  > **NOTE:** Keep in mind that this only applies on system calls, i.e. on `Nt*`
  > or `Zw*` functions. Other functions are not called from the 32-bit `ntdll.dll` 
  > to the 64-bit `ntdll.dll`. For example, if we hooked `RtlDecompressBuffer`
  > in the native `ntdll.dll` of the WoW64 process, it wouldn't be called
  > on `ntdll32!RtlDecompressBuffer` call. This is because the full implementaion of the
  > `Rtl*` functions is already in the `ntdll32.dll`.

- We can "harmlessly" patch high-word moved to the `eax` in every WoW64 system call stub to 0.
  For example we could see in `NtWaitForSingleObject` there is `mov eax, 0D0004h`.
  If we patched appropriate 2 bytes in that instruction so that the instruction
  would become `mov eax, 4h`, the system call would still work.
  
  This approach can be used as an anti-hooking technique - if there's a jump
  at the start of the function, the patch will break it. If there's not a jump,
  we just disable the Turbo thunk for this function.

## x86 on ARM64

Emulation of x86 applications on ARM64 is handled by an actual binary translation.
Instead of `wow64cpu.dll`, the `xtajit.dll` (probably shortcut for "x86 to ARM64 JIT")
is used for its emulation. As with other emulation DLLs, this DLL is native (ARM64).

The x86 emulation on Windows ARM64 consists also of other "XTA" components:
- `xtac.exe` - XTA Compiler
- `XtaCache.exe` - XTA Cache Service

Execution of x86 programs on ARM64 appears to go way behind just emulation. It
is also capable of caching already binary-translated code, so that next execution
of the same application should be faster. This cache is located in the `Windows\XtaCache`
directory which contains files in format `FILENAME.EXT.HASH1.HASH2.mp.N.jc`.
These files are then mapped to the user-mode address space of the application.
If you're asking whether you can find an actual ARM64 code in these files - indeed,
you can.

Unfortunatelly, Microsoft doesn't provide symbols to any of these `xta*` DLLs or executables. But if
you're feeling adventurous, you can find some interesting artifacts, like
this array of structures inside of the `xtajit.dll`, which contains name of the function and its pointer.
There are thousands of items in this array:

{% include image.html
   src="/img/posts/2/IDA_BT_Before_ARM64.png"
   alt="BT functions (before) (ARM64)"
   caption="BT functions (before) (ARM64)"
%}

With a simple Python script, we can mass-rename all functions referenced in
this array:

<script src="https://gist.github.com/wbenny/d58b0bd48991788f6ac633b661d4908c.js"></script>

I'd like to thank _Milan Boháček_ for providing me this script.

{% include image.html
   src="/img/posts/2/IDA_BT_After_ARM64.png"
   alt="BT functions (after) (ARM64)"
   caption="BT functions (after) (ARM64)"
%}

{% include image.html
   src="/img/posts/2/IDA_BT_List_ARM64.png"
   alt="BT translated function list (ARM64)"
   caption="BT translated function list (ARM64)"
%}

### `Windows\SyCHPE32` & `Windows\SysWOW64`

One thing you can observe on ARM64 is that it contains two folders used for x86
emulation. The difference between them is that `SyCHPE32` contains small subset
of DLLs that are frequently used by applications, while contents of the `SysWOW64`
folder is quite identical with the content of this folder on Windows x64.

The `CHPE` DLLs are not pure-x86 DLLs and not even pure-ARM64 DLLs. They are
"compiled-hybrid-PE"s. What does it mean? Let's see:

{% include image.html
   src="/img/posts/2/IDA_CHPE_x86_NtMapViewOfSection_ARM64.png"
   alt="NtMapViewOfSection (CHPE) (ARM64)"
   caption="NtMapViewOfSection (CHPE) (ARM64)"
%}

After opening `SyCHPE32\ntdll.dll`, IDA will first tell us - unsurprisingly -
that it cannot download PDB for this DLL. After looking at randomly chosen `Nt*`
function, we can see that it doesn't differ from what we would see in the
`SysWOW64\ntdll.dll`. Let's look at some non-`Nt*` function:

{% include image.html
   src="/img/posts/2/IDA_CHPE_x86_RtlDecompressBuffer_ARM64.png"
   alt="RtlDecompressBuffer (CHPE) (ARM64)"
   caption="RtlDecompressBuffer (CHPE) (ARM64)"
%}

We can see it contains regular x86 function prologue, immediately followed by
x86 function epilogue and then jump somewhere, where it looks like that there's
just garbage. That "garbage" is actually ARM64 code of that function.

My guess is that the reason for this prologue is probably compatibility with
applications that check whether some particular functions are hooked or not -
by checking if the first bytes of the function contain real x86 prologue.

> **NOTE:** Again, if you're feeling adventurous, you can patch `FileHeader.Machine`
> field in the PE header to `IMAGE_FILE_MACHINE_ARM64 (0xAA64)` and open this
> file in IDA. You will see a whole lot of correctly resolved ARM64 functions.
> Again, I'd like to thank to _Milan Boháček_ for this tip.

If your question is "how are these images generated?", I would answer that I don't know,
but my bet would be on some internal version of Microsoft's C++ compiler toolchain. This idea
appears to be supported by [various occurences of the `CHPE` keyword in the ChakraCore codebase][chakra-chpe].

## ARM32 on ARM64

The loop inside of the `wowarmhw!BTCpuSimulate` is fairly simple compared to
`wow64cpu.dll` loop:

<script src="https://gist.github.com/wbenny/bbad92111d174c0fbf9ffa7d23fed1a4.js"></script>

`CpupSwitchTo32Bit` does nothing else than saving the whole `CONTEXT`, performing `SVC 0xFFFF`
instruction and then restoring the `CONTEXT`.

### `nt!KiEnter32BitMode` / `SVC 0xFFFF`

I won't be explaining here how system call dispatching works in the `ntoskrnl.exe` - 
[Bruce Dang already did an excellent job doing it][bruce-dang-arm64-syscall].
This section is a follow up on his article, though.

`SVC` instruction is sort-of equivalent of `SYSCALL` instruction on ARM64 - it
basically enters the kernel mode. But there is a small difference between `SYSCALL`
and `SVC`: while on Windows x64 the system call number is moved into
the `eax` register, on ARM64 the system call number can be encoded directly
into the `SVC` instruction.

{% include image.html
   src="/img/posts/2/IDA_SVC_FFFF_ARM64.png"
   alt="SVC 0xFFFF (ARM64)"
   caption="SVC 0xFFFF (ARM64)"
%}

Let's peek for a moment into the kernel to see how is this `SVC` instruction handled:

- `nt!KiUserExceptionHandler`
    - `nt!KiEnter32BitMode`

{% include image.html
   src="/img/posts/2/IDA_KiUserExceptionHandler_ARM64.png"
   alt="KiUserExceptionHandler (ARM64)"
   caption="KiUserExceptionHandler (ARM64)"
%}

{% include image.html
   src="/img/posts/2/IDA_KiEnter32BitMode_ARM64.png"
   alt="KiEnter32BitMode (ARM64)"
   caption="KiEnter32BitMode (ARM64)"
%}

We can see that:

- `MRS X30, ELR_EL1` - current interrupt-return address (stored in `ELR_EL1` system
  register) will be moved to the register `X30` (link register - `LR`).
- `MSR ELR_EL1, X15` - the interrupt-return address will be replaced by value
  in the register `X15` (**which is aliased to the instruction pointer register** -
  `PC` - in the 32-bit mode).
- `ORR X16, X16, #0b10000` - bit [4] is being set in `X16` which is later moved
  to the `SPSR_EL1` register. Setting this bit **switches the execution mode to
  32-bits**.
  
Simply said, in the `X15` register, there is an address that will be
executed once we leave the kernel-mode and enter the user-mode - which happens
with the `ERET` instruction at the end.

### `nt!KiExit32BitMode` / `UND #0xF8`

Alright, we're in the 32-bit ARM mode now, how exactly do we leave? Windows
solves this transition via `UND` instruction - which is similar to the `UD2`
instruction on the **Intel** CPUs. If you're not familiar with it, you just
need to know that it is instruction that basically guarantees that it'll
throw "invalid instruction" exception which can OS kernel handle. It is defined-"undefined instruction".
Again there is the same difference between the `UND` and `UD2` instruction in
that the ARM can have any 1-byte immediate value encoded directly in the
instruction.

Let's look at the `NtMapViewOfSection` system call in the `SysArm32\ntdll.dll`:

{% include image.html
   src="/img/posts/2/IDA_ARM32_NtMapViewOfSection_ARM64.png"
   alt="NtMapViewOfSection (ARM64)"
   caption="NtMapViewOfSection (ARM64)"
%}

Let's peek into the kernel again:

- `nt!KiUser32ExceptionHandler`
    - `nt!KiFetchOpcodeAndEmulate`
        - `nt!KiExit32BitMode`

{% include image.html
   src="/img/posts/2/IDA_KiFetchOpcodeAndEmulate_ARM64.png"
   alt="KiEnter32BitMode (ARM64)"
   caption="KiEnter32BitMode (ARM64)"
%}

{% include image.html
   src="/img/posts/2/IDA_KiExit32BitMode_ARM64.png"
   alt="KiEnter32BitMode (ARM64)"
   caption="KiEnter32BitMode (ARM64)"
%}

Keep in mind that meanwhile the 32-bit code is running, it cannot modify the value of the
previously stored `X30` register - it is not visible in 32-bit mode. It stays there the
whole time. Upon `UND #0xF8` execution, following happens:

- the `KiFetchOpcodeAndEmulate` function moves value of `X30` into `X24` register
  (not shown on the screenshot).
- `AND X19, X16, #0xFFFFFFFFFFFFFFC0` - bit [4] (among others) is being cleared
  in the `X19` register, which is later moved to the `SPSR_EL1` register.
  Clearing this bit **switches the execution mode back to 64-bits**.
- `KiExit32BitMode` then moves the value of `X24` register into the `ELR_EL1` register. That means when
  this function finishes its execution, the `ERET` brings us back to the 64bit code,
  right after the `SVC 0xFFFF` instruction.

> **NOTE:** It can be noticed that Windows uses `UND` instruction for several
> purposes. Common example might also be `UND #0xFE` which is used as a breakpoint
> instruction (equivalent of `__debugbreak()` / `int3`)

As you could spot, 3 kernel transitions are required for emulation of the
system call (`SVC 0xFFFF`, system call itself, `UND 0xF8`). This is because on
ARM there doesn't exist a way how to switch between 32-bit and 64-bit mode only
in user-mode.

If you're looking for "ARM Heaven's Gate" - this is it. Put whatever function
address you like into the `X15` register and execute `SVC 0xFFFF`.
Next instruction will be executed in the 32-bit ARM mode, starting with that
address. When you feel you'd like to come back into 64-bit mode, simply
execute `UND #0xF8` and your execution will continue with the next instruction
after the `SVC 0xFFFF`.

## Appendix

<script src="https://gist.github.com/wbenny/41b2bf4256f28d61bcc336f10650b3d2.js"></script>

## References

How does one retrieve the 32-bit context of a Wow64 program from a 64-bit process on Windows Server 2003 x64?<br>
[http://www.nynaeve.net/?p=191][nynaeve-wow64-context]

Mixing x86 with x64 code<br>
[http://blog.rewolf.pl/blog/?p=102][rewolf-mixing-code]

Windows 10 on ARM<br>
[https://channel9.msdn.com/Events/Build/2017/P4171][channel9-chpe]

Knockin’ on Heaven’s Gate – Dynamic Processor Mode Switching<br>
[http://rce.co/knockin-on-heavens-gate-dynamic-processor-mode-switching/][knocking-on-heavens-gate]

Closing “Heaven’s Gate”<br>
[http://www.alex-ionescu.com/?p=300][alex-closing-heavens-gate]


[msdn-wow64-details]: <https://docs.microsoft.com/en-us/windows/desktop/winprog64/wow64-implementation-details>
[msdn-ums]: <https://docs.microsoft.com/en-us/windows/desktop/procthread/user-mode-scheduling>
[msdn-createenclave]: <https://docs.microsoft.com/en-us/windows/desktop/api/enclaveapi/nf-enclaveapi-createenclave>
[alex-mrdata]: <http://alex-ionescu.com/publications/euskalhack/euskalhack2017-cfg.pdf>
[injdrv]: <https://github.com/wbenny/injdrv>
[wow64log]: <http://waleedassar.blogspot.com/2013/01/wow64logdll.html>
[chakra-chpe]: <https://github.com/Microsoft/ChakraCore/search?q=CHPE&unscoped_q=CHPE>
[bruce-dang-arm64-syscall]: <https://gracefulbits.com/2018/07/26/system-call-dispatching-for-windows-on-arm64/>
[msdn-process-mitigation-dynamic-code-policy]: <https://docs.microsoft.com/en-us/windows/desktop/api/winnt/ns-winnt-_process_mitigation_dynamic_code_policy>
[osdev-long-mode]: <https://wiki.osdev.org/Setting_Up_Long_Mode>

[nynaeve-wow64-context]: <http://www.nynaeve.net/?p=191>
[rewolf-mixing-code]: <http://blog.rewolf.pl/blog/?p=102>
[channel9-chpe]: <https://channel9.msdn.com/Events/Build/2017/P4171>
[knocking-on-heavens-gate]: <http://rce.co/knockin-on-heavens-gate-dynamic-processor-mode-switching/>
[alex-closing-heavens-gate]: <http://www.alex-ionescu.com/?p=300>
