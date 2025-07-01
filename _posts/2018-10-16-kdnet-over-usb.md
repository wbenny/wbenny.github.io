---
layout:     post
title:      "KDNET over USB"
subtitle:   Remote kernel debugging (not only) your Windows on ARM
date:       2018-10-16 23:50:00 +0200
---

_Windows on ARM_ is slowly getting its way on the market ([again][win-rt]).
Some Windows internals enthusiasts can't wait to peek under the hood,
which goes hand-in-hand with question whether attaching remote kernel
debugger - and disabling **Secure Boot** - is possible. Of course, it is.

Recently I've got lucky enough to put my hands on [HP Envy x2][hp-envy-x2],
which - at the time of this writing - is only one of 3 devices on the market
that officially supports [Windows 10 on 64-bit ARM][windows-on-arm] (other 2
devices being [ASUS NovaGo][asus-novago] and [Lenovo Miix 630][lenovo-miix-630]).
Currently, all 3 devices have [Snapdragon 835][snapdragon-835], a Qualcomm
64-bit ARM (aarch64) CPU and generally, these devices don't differ much in the
terms of technical specifications.

> I'd like to note that while I was able to make remote kernel debugging
> work with _HP Envy x2_, it might not be possible for other devices. Specifically,
> I've been told that while disabling **Secure Boot** is possible on _ASUS NovaGo_,
> attaching remote kernel debugger via **KDNET over USB** is not. This might be
> because _HP Envy x2_ has _USB-C_, while _ASUS NovaGo_ has regular _USB 3.1_
> port. I know nobody who tried this on _Lenovo Miix 630_, but assuming it has
> _USB-C_ as well, it should work.
>
> As for USB cable, any **USB-C to USB-C** or even **USB-C to USB-A** cable
> should do the trick. I've been using my charging cable from _Samsung Galaxy S9+_
> (**USB-C to USB-A**) without any problems.

Today, when someone wants to debug the Windows kernel remotely, it's mostly
done via network - **KDNET**. MSDN offers [detailed][kdnet-auto] [documentation][kdnet-manual]
on how to achieve that. But what if you're presented with a device - such as
laptop, tablet or phone - that doesn't have any Ethernet port? If you have a device
with USB port, EHCI/xHCI controller that supports debugging, you can use a
[special][cable-usb2] [USB][cable-usb3] cable and follow [MSDN][km-dbg-usb2]
[instructions][km-dbg-usb3]. Unfortunatelly, this method has several disadvantages:
- Not all EHCI/xHCI controllers are capable of debugging
- Debugging USB cables are not cheap - and often even hard to find
- USB debugging is known to not always work very reliably

The another option is to make **KDNET** work over **USB**. "What is that?!",
you may ask, followed by "...there's nothing on MSDN about that!". And you'd be
*kinda* right. After a bit of googling, you'll find out that there are some
mentions about it burried deep down in [Windows HLK Test reference][hlk-kdnet-over-usb]
or [Azure's github][azure-iot-github] on how to connect _Inventec Avatar device_
(whatever that is) to Windows 10 IoT.

They both mention having **VirtEth.exe** as a prerequisite, which I was unable
to find on the Internet. Apparently, it's supposed to be packed in _Windows Phone Kit_
which appears to be available only to particular OEM/vendors. I started to lose
any hope, when suddenly I just spotted a new network adapter in my network
settings:

![kdnet](/img/posts/1/kdnet.png)

_so, it'll maybe work somehow!_

After a bunch of `ipconfig` commands and a few trial-and-errors, I actually succeeded.
I'm not sure how recent this feature is and since which Windows version is this feature
available (the only computers I've tested it with are running Windows 10 RS5). I'm not
even sure if Microsoft decides to properly document this debugging method. But in any
case, here are steps you need to perform:


0.  Disable **Secure Boot** via BIOS settings (on _HP Envy x2_ hold `ESC` button during boot)
1.  Connect PCs with USB cable
2.  On target:
    ```
    bcdedit /debug on
    bcdedit /dbgsettings net hostip:169.254.255.255 port:50000 key:1.2.3.4
    ```
    (dummy IP, because we don't know what address will be assigned to the host)
3.  Reboot target
4.  During boot of the target, the host should should make that familiar _"USB connected beep"_,
    and **Windows KDNET USB-EEM** network adapter should show up under
    **Network Connections** folder in the **Control Panel**
5.  Get IP address of that network adapter, either via double-click & detail, or
    via `ipconfig` (it might take some time until the IP is assigned)
6.  It might take some time before target starts to boot - in my case it'll
    freeze during boot for ~30s (waiting for debugger), then the boot will resume
7.  Once is target booted, do on target:
    ```
    bcdedit /dbgsettings net hostip:X.X.X.X port:50000 key:1.2.3.4
    ```
    where **X.X.X.X** = correct IP of host's KDNET adapter determined in step #6
8.  Also on target: `ipconfig`, and look for Ethernet adapter with `(Kernel Debugger)`
    in its name, take note of its IP address
9.  Reboot target
10. On host: `windbg -k net:port=50000,key=1.2.3.4,target=<target ip>` - or use WinDbgX preview

... it might take some time until it connects

> Note: If it doesn't work, check your firewall settings.


[win-rt]: <https://en.wikipedia.org/wiki/Windows_RT>
[kdnet-manual]: <https://docs.microsoft.com/en-us/windows-hardware/drivers/debugger/setting-up-a-network-debugging-connection>
[kdnet-auto]: <https://docs.microsoft.com/en-us/windows-hardware/drivers/debugger/setting-up-a-network-debugging-connection-automatically>
[cable-usb2]: <https://www.apriorit.com/dev-blog/210-win-debug-with-usb>
[cable-usb3]: <https://www.datapro.net/products/usb-3-0-super-speed-a-a-debugging-cable.html>
[km-dbg-usb2]: <https://docs.microsoft.com/en-us/windows-hardware/drivers/debugger/setting-up-a-usb-2-0-debug-cable-connection>
[km-dbg-usb3]: <https://docs.microsoft.com/en-us/windows-hardware/drivers/debugger/setting-up-a-usb-3-0-debug-cable-connection>
[hlk-kdnet-over-usb]: <https://docs.microsoft.com/en-us/windows-hardware/test/hlk/testref/8424cf29-e2b4-4060-bb90-4ea503ce704b>
[azure-iot-github]: <https://github.com/Azure/azure-iot-device-ecosystem/blob/master/get_started/windows10-iot-core-avatar-csharp.md>
[hp-envy-x2]: <https://www8.hp.com/us/en/campaigns/envy-x2/overview.html>
[asus-novago]: <https://www.asus.com/2-in-1-PCs/ASUS-NovaGo-TP370QL/>
[lenovo-miix-630]: <https://www.lenovo.com/us/en/tablets/windows-tablets/miix-series/Lenovo-Miix-630-12Q35/p/88IPMX60984>
[snapdragon-835]: <https://www.qualcomm.com/products/snapdragon/processors/835>
[windows-on-arm]: <https://docs.microsoft.com/en-us/windows/arm/>
