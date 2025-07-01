---
layout:     post
title:      "I made my VM think it has a CPU fan"
subtitle:   ...so the malware would finally shut up and run
date:       2025-06-29 10:00:00 +0200
---

## Why bother?

Some malware samples are known to do various checks to determine if they are
running in a virtual machine. One of the common checks is to look for
the presence of certain hardware components that are typically not emulated
in virtualized environments. One such component is the **CPU fan**.
One of the observed ways malware checks for the presence of a CPU fan is by
looking for the `Win32_Fan` class in WMI:

```
wmic path Win32_Fan get *
```

And the reason they do this is they want to avoid running
in virtual machines, because they want to complicate the analysis process
for security researchers.

There are plenty of ways for malware to detect if it is running in a VM.
In fact, there are plenty of WMI classes that can reveal the presence of
virtual hardware, such as `Win32_CacheMemory`, `Win32_VoltageProbe`, and
[many others].

In this post, I will be focusing on the CPU fan. Just because I like the idea
making a virtual machine think it has it. However, the same approach can
be applied to other hardware components and WMI classes as well.

## How the computer knows it has a CPU fan?

The computer knows it has a CPU fan by reading the
<abbr title="System Management BIOS">**SMBIOS**</abbr> data.

How do I know that? [By googling].

> `Win32_Fan` instances are provided by `Windows\System32\wbem\cimwin32.dll`.
> If you disassemble it you will see that it reads SMBIOS data (specifically
> entries with type 27) to get fan device information.

And indeed, if you disassemble `cimwin32.dll`, you will find exactly that:

![cimwin32.dll](/img/posts/5/ida_cimwin32.png)

Your first impulse might be to use DLL hooking and patch the `cimwin32`.
But that's detectable. We can do better.

## Type 27

The SMBIOS type 27 is defined as **"Cooling Device"** in the
[System Management BIOS Reference Specification]:

![Cooling Device (Type 27) structure](/img/posts/5/type27.png)

We can dump the SMBIOS data using the `dmidecode` utility:

```
root@host:/# dmidecode -t27 -u
# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.4 present.

Handle 0x1B00, DMI type 27, 15 bytes
        Header and Data:
                1B 0F 00 1B 00 1C 65 00 00 DD 00 00 E0 15 01
        Strings:
                43 50 55 20 46 61 6E 00
                CPU Fan
```

By default, the `dmidecode` utility will interpret the data and display it in a
more human-readable format:

```
root@host:/# dmidecode -t27
# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.4 present.

Handle 0x1B00, DMI type 27, 15 bytes
Cooling Device
        Temperature Probe Handle: 0x1C00
        Type: Chip Fan
        Status: OK
        OEM-specific Information: 0x0000DD00
        Nominal Speed: 5600 rpm
        Description: CPU Fan
```

## Setting custom SMBIOS data in Xen

At the time of writing, the only available resource I found on how to set custom
SMBIOS data in Xen is this [almost 10 years old mcnewton's post]. I recommend
reading it, as it exactly describes the struggle I had when figuring this out.

In short, you can set custom SMBIOS data in Xen by setting the `smbios_firmware`
option in the domain configuration file to the path to a file containing
the SMBIOS data.

So, let's create a file named `smbios.bin` with the following byte content:

<pre>
1B 0F 00 1B 00 1C 65 00 00 DD 00 00 E0 15 01 43
50 55 20 46 61 6E 00 <strong><u>00</u></strong>
</pre>

Note that the content is same as the output of `dmidecode -t27 -u` above,
but with additional `00` byte at the end, because the SMBIOS specification
requires it.

In the [Xen domain configuration file documentation], we can also find this:

> Since SMBIOS structures do not present their overall size, each entry in the
> file must be preceded by a 32b integer indicating the size of the following
> structure.

Our structure is 24 bytes long, so we need to prepend the content with
`18 00 00 00` (24 in little-endian):

<pre>
<strong><u>18 00 00 00</u></strong> 1B 0F 00 1B 00 1C 65 00 00 DD 00 00
E0 15 01 43 50 55 20 46 61 6E 00 00
</pre>

Now we can set the `smbios_firmware` option in the Xen domain configuration file
to the path to this file:

```ini
smbios_firmware = "/path/to/smbios.bin"
```

Let's save the configuration file and start our Windows domain.

```
root@host:/# xl create /path/to/windows/domain.cfg
```

And let's check if the CPU fan is now present in the Windows VM:

```
PS C:\> wmic path Win32_Fan get *
No Instance(s) Available.
```

Oh noes. Something's wrong.

### The Betrayal

I missed one important detail in the documentation of the `smbios_firmware` option:

> **smbios_firmware="STRING"**
>> Specifies a path to a file that contains extra SMBIOS firmware ...
>> **Not all predefined structures can be overridden, only the following types:
>> 0, 1, 2, 3, 11, 22, 39**. The file can also ...

Frankly, I did _not_ miss this at first. I just hoped that what I was trying to
do was not _"overriding"_ the predefined structure.

Because Xen (or rather `hvmloader`) [does not define it].

So, before defining it myself, I tried to find out if there was any other poor
soul who tried to do the same thing before me. And to my disappointment, there
**was**. Right in the <abbr title="[XEN PATCH] tools/firmware/hvmloader/smbios.c: Add new SMBIOS tables (7,8,9,26,27,28)">[xen-devel patch archive]</abbr>.

Why it was my disappointment, you may ask? Because after reading the response
to the patch, I felt the frustration of the author. But that's for another story.

Anyway, the patch was rejected, but it's small and simple, so it's easy
to apply it to the Xen source code.

### Type 28, too

After applying the patch and recompiling Xen, I was still getting
`No Instance(s) Available` error when trying to query the `Win32_Fan` class.

It didn't make sense to me, so I dumped the SMBIOS data from the VM, to check
whether the type 27 was present ([`dmidecode` is available on Windows, too!]):

```
PS C:\> .\dmidecode -t27
# dmidecode 3.5
SMBIOS 2.4 present.

Handle 0x1B00, DMI type 27, 15 bytes
Cooling Device
        Temperature Probe Handle: 0x1C00
        Type: Chip Fan
        Status: OK
        OEM-specific Information: 0x0000DD00
        Nominal Speed: 5600 rpm
        Description: CPU Fan
```

It was there! But why was it not showing up in WMI? I noticed this line:

```
        Temperature Probe Handle: 0x1C00
```

This line indicates that the cooling device (CPU fan) is associated with a
temperature probe, which is another SMBIOS type (type 28). However, the
temperature probe was not defined in the SMBIOS data:

```
PS C:\> .\dmidecode -t28
# dmidecode 3.5
SMBIOS 2.4 present.
```

That's it.

One more table to fake.

So let's shut down the VM and dump the type 28 data from the host:

```
root@host:/# dmidecode -t28
# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.4 present.

Handle 0x1C00, DMI type 28, 22 bytes
Temperature Probe
        Description: CPU Thermal Probe
        Location: Processor
        Status: OK
        Maximum Value: 0.0 deg C
        Minimum Value: 0.0 deg C
        Resolution: 0.000 deg C
        Tolerance: 0.0 deg C
        Accuracy: 0.00%
        OEM-specific Information: 0x0000DC00
        Nominal Value: 0.0 deg C
```

And again, the byte representation:

```
root@host:/# dmidecode -t28 -u
# dmidecode 3.3
Getting SMBIOS data from sysfs.
SMBIOS 3.4 present.

Handle 0x1C00, DMI type 28, 22 bytes
        Header and Data:
                1C 16 00 1C 01 63 00 00 00 00 00 00 00 00 00 00
                00 DC 00 00 00 00
        Strings:
                43 50 55 20 54 68 65 72 6D 61 6C 20 50 72 6F 62
                65 00
                CPU Thermal Probe
```

Therefore, this is the content we need to append to our `smbios.bin` file
(again, mind the extra `00` byte at the end):

<pre>
1C 16 00 1C 01 63 00 00 00 00 00 00 00 00 00 00
00 DC 00 00 00 00 43 50 55 20 54 68 65 72 6D 61
6C 20 50 72 6F 62 65 00 <strong><u>00</u></strong>
</pre>

Oh right! We need to prepend the size of the structure, which is 41 bytes this
time (0x29 in hex):

<pre>
<strong><u>29 00 00 00</u></strong> 1C 16 00 1C 01 63 00 00 00 00 00 00
00 00 00 00 00 DC 00 00 00 00 43 50 55 20 54 68
65 72 6D 61 6C 20 50 72 6F 62 65 00 00
</pre>

So, the final content of our `smbios.bin` file should look like this:
<pre>

<strong><u>18 00 00 00</u></strong> 1B 0F 00 1B 00 1C 65 00 00 DD 00 00
E0 15 01 43 50 55 20 46 61 6E 00 00 <strong><u>29 00 00 00</u></strong>
1C 16 00 1C 01 63 00 00 00 00 00 00 00 00 00 00
00 DC 00 00 00 00 43 50 55 20 54 68 65 72 6D 61
6C 20 50 72 6F 62 65 00 00
</pre>

### Xth Time's the Charm

Let's save the file and start our Windows domain again:

```
root@host:/# xl create /path/to/windows/domain.cfg
```

And let's check if the CPU fan is now present in the Windows VM:

```
PS C:\> wmic path Win32_Fan get Description,Status
Description     Status
Cooling Device  OK
```

Yay! The VM now thinks it has a CPU fan!

If you're wondering why I didn't use `*` in the `wmic` command, it's because
the `Win32_Fan` class has _*many*_ properties, and I wanted to keep the output
short and sweet. `wmic path Win32_Fan get *` would work just as well.

## Setting custom SMBIOS data in QEMU/KVM

If you're using QEMU/KVM instead of Xen, your life is much easier. You don't
need to patch anything. You can set custom SMBIOS data using the `-smbios`
option:

```bash
qemu-system-x86_64 ... -smbios file=/path/to/smbios.bin
```

Or, if you're using libvirt:

```xml
  <qemu:commandline>
    <qemu:arg value='-smbios'/>
    <qemu:arg value='file=/path/to/smbios.bin'/>
  </qemu:commandline>
```

However! Remember how Xen required those 32-bit integers indicating the
structure sizes? QEMU does not require them, so you can just use the raw data
without prepending the size:

```
1B 0F 00 1B 00 1C 65 00 00 DD 00 00 E0 15 01 43
50 55 20 46 61 6E 00 00 1C 16 00 1C 01 63 00 00
00 00 00 00 00 00 00 00 00 DC 00 00 00 00 43 50
55 20 54 68 65 72 6D 61 6C 20 50 72 6F 62 65 00
00
```

That's it! QEMU will automatically handle rest of the important SMBIOS entries
for you.

However, if you're wondering whether you could just take the host's SMBIOS data
and use it in the VM, the answer is **yes**. You can try that on your own:

```bash
cat /sys/firmware/dmi/tables/DMI > /path/to/smbios.bin
```

## References

- **Xen domain configuration file syntax:**<br/>
  https://xenbits.xen.org/docs/unstable/man/xl.cfg.5.html

- **mcnewton's notes - Setting custom SMBIOS data in Xen DomUs:**<br/>
  https://notes.asd.me.uk/2015/12/04/setting-custom-smbios-data-in-xen-domus/

- **[XEN PATCH] tools/firmware/hvmloader/smbios.c: Add new SMBIOS tables (7,8,9,26,27,28):**<br/>
  https://old-list-archives.xen.org/archives/html/xen-devel/2022-01/msg00725.html

- **System Management BIOS Reference Specification:**<br/>
  https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.7.1.pdf

- **QEMU Anti Detection patches:**<br/>
  https://github.com/zhaodice/qemu-anti-detection


[many others]: https://github.com/zhaodice/qemu-anti-detection?tab=readme-ov-file#flaws-this-patch-does-not-fix-in-qemus-source
[By googling]: https://stackoverflow.com/a/66605083/2011432
[System Management BIOS Reference Specification]: https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.7.1.pdf
[almost 10 years old mcnewton's post]: https://notes.asd.me.uk/2015/12/04/setting-custom-smbios-data-in-xen-domus/
[Xen domain configuration file documentation]: https://xenbits.xen.org/docs/unstable/man/xl.cfg.5.html#smbios_firmware-STRING
[does not define it]: https://github.com/xen-project/xen/blob/afbb876f1fe6f45ca5c3c425925d3d15101c7382/tools/firmware/hvmloader/smbios.c#L66-L98
[xen-devel patch archive]: https://old-list-archives.xen.org/archives/html/xen-devel/2022-01/msg00725.html
[`dmidecode` is available on Windows, too!]: https://github.com/crystalidea/dmidecode-win
